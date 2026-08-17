/**
 * Shared command plumbing: global flags, effective context, client construction, and the one
 * outcome→emit→exit funnel every handler returns through.
 */
import type { Command } from 'commander';
import { ApiClient } from '../api/client.ts';
import { CliError } from '../cliError.ts';
import { resolveContext, type EffectiveContext } from '../config/context.ts';
import { emitError, emitOutcome, note, type CommandOutcome, type EmitOptions } from '../output/emit.ts';
import { exitCodeForError, EXIT_INTERNAL } from '../output/exitCodes.ts';
import { requireCredential, type ResolvedCredential } from '../auth/credentials.ts';
import { clearLastError, persistLastError } from '../config/state.ts';
import { emitUpdateNotice } from '../update.ts';

export interface GlobalFlags {
  json: boolean;
  /** --pretty: pretty-print --json output (compact is the default). */
  pretty: boolean;
  quiet: boolean;
  noInput: boolean;
  noRetry: boolean;
  org?: string;
  apiBase?: string;
  /** --timeout in seconds. */
  timeout?: number;
}

/** Attach the cli.md §2.1 global flags to a leaf command (usable at any position). */
export function addGlobalFlags(cmd: Command): Command {
  return cmd
    .option('--json', 'machine output: exactly one compact JSON document on stdout; implies --no-input')
    .option('--pretty', 'pretty-print the --json document')
    .option('--org <org>', 'override the configured org context for this invocation')
    .option('--api-base <url>', 'endpoint override (staging/dev)')
    .option('-q, --quiet', 'suppress non-essential stderr')
    .option('--no-input', 'fail instead of prompting (implied by --json)')
    .option('--timeout <s>', 'per-command ceiling override, seconds', parsePositiveInt)
    .option('--no-retry', 'disable the built-in busy/transport retry');
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw CliError.usage(`Invalid --timeout value '${value}'.`);
  return parsed;
}

export function globalFlags(cmd: Command): GlobalFlags {
  const opts = cmd.optsWithGlobals<Record<string, unknown>>();
  const json = opts.json === true;
  return {
    json,
    pretty: opts.pretty === true,
    quiet: opts.quiet === true,
    noInput: json || opts.input === false,
    noRetry: opts.retry === false,
    org: typeof opts.org === 'string' ? opts.org : undefined,
    apiBase: typeof opts.apiBase === 'string' ? opts.apiBase : undefined,
    timeout: typeof opts.timeout === 'number' ? opts.timeout : undefined,
  };
}

export interface Invocation {
  flags: GlobalFlags;
  context: EffectiveContext;
  env: NodeJS.ProcessEnv;
  emitOpts: EmitOptions;
  /** Stderr progress line (never stdout). */
  note: (message: string) => void;
}

export function buildInvocation(cmd: Command, env: NodeJS.ProcessEnv = process.env): Invocation {
  const flags = globalFlags(cmd);
  const context = resolveContext({ org: flags.org, apiBase: flags.apiBase }, env);
  const emitOpts: EmitOptions = { json: flags.json, quiet: flags.quiet, pretty: flags.pretty };
  return { flags, context, env, emitOpts, note: (message) => note(message, { quiet: flags.quiet }) };
}

export interface AuthedClient {
  client: ApiClient;
  credential: ResolvedCredential;
}

export async function authedClient(inv: Invocation, timeoutMsDefault?: number): Promise<AuthedClient> {
  const credential = await requireCredential({
    apiBase: inv.context.apiBase.value,
    org: inv.context.org.value,
    env: inv.env,
  });
  const client = new ApiClient({
    apiBase: inv.context.apiBase.value,
    apiKey: credential.key,
    noRetry: inv.flags.noRetry,
    defaultTimeoutMs: inv.flags.timeout !== undefined ? inv.flags.timeout * 1000 : timeoutMsDefault,
    env: inv.env,
    onNotice: inv.note,
  });
  return { client, credential };
}

export function anonymousClient(inv: Invocation, timeoutMsDefault?: number): ApiClient {
  return new ApiClient({
    apiBase: inv.context.apiBase.value,
    noRetry: inv.flags.noRetry,
    defaultTimeoutMs: inv.flags.timeout !== undefined ? inv.flags.timeout * 1000 : timeoutMsDefault,
    env: inv.env,
    onNotice: inv.note,
  });
}

/**
 * Standard `meta` block on every --json document: request_id (server correlation — present on
 * every wire-backed envelope) + duration_ms (the latency instrument). CLI/API versions are NOT
 * repeated here — `moda version` / `moda doctor` own them.
 */
export function metaBlock(extra: { requestId?: string; durationMs?: number } = {}): Record<string, unknown> {
  return {
    ...(extra.requestId !== undefined ? { request_id: extra.requestId } : {}),
    ...(extra.durationMs !== undefined ? { duration_ms: extra.durationMs } : {}),
  };
}

/**
 * Semantic markers for the machine-readable verb schema (`moda describe` / `__inventory`).
 * Tagged AT the registration site — the command definition is the single source of truth.
 * `destructive` is not tagged: it is derived from the presence of a --yes gate.
 */
export interface VerbSemantics {
  /** Changes server-side state. */
  mutating?: boolean;
  /** Spends Moda credits. The response carries usage.class, never the per-call credit amount. */
  metered?: boolean;
  /** Returns/refreshes the pinnable revision token (the read lane writes pin against). */
  read_lane?: boolean;
}

const verbSemanticsRegistry = new WeakMap<Command, VerbSemantics>();

export function tagVerb(cmd: Command, semantics: VerbSemantics): Command {
  verbSemanticsRegistry.set(cmd, semantics);
  return cmd;
}

export function verbSemanticsOf(cmd: Command): VerbSemantics {
  return verbSemanticsRegistry.get(cmd) ?? {};
}

type ActionHandler = (positionals: string[], opts: Record<string, unknown>, cmd: Command) => Promise<CommandOutcome>;

/**
 * Wrap a handler as a commander action: funnel the outcome (or error) through emit, print the
 * once-daily update notice to stderr, and exit with the mapped code.
 */
export function wrapAction(handler: ActionHandler): (...cliArgs: unknown[]) => Promise<void> {
  return async (...cliArgs: unknown[]) => {
    const cmd = cliArgs.at(-1) as Command;
    const opts = (cliArgs.at(-2) ?? {}) as Record<string, unknown>;
    const positionals = cliArgs.slice(0, -2).flat().filter((a): a is string => typeof a === 'string');
    const flags = globalFlags(cmd);
    const emitOpts: EmitOptions = { json: flags.json, quiet: flags.quiet, pretty: flags.pretty };
    try {
      const outcome = await handler(positionals, opts, cmd);
      emitOutcome(outcome, { ...emitOpts, summaryToStderr: outcome.summaryToStderr === true });
      if (!flags.quiet) emitUpdateNotice(process.env);
      // A zero exit clears the recorded failure — `moda last-error` always means the LAST run.
      if (outcome.exitCode === 0 && cmd.name() !== 'last-error') clearLastError();
      process.exit(outcome.exitCode);
    } catch (err) {
      const fields = err instanceof CliError ? err.fields : CliError.internal(describeUnknown(err)).fields;
      const exitCode = exitCodeForError(fields);
      const doc = errorDoc(fields);
      // Every nonzero exit leaves its full envelope behind: `moda last-error` re-prints it, so a
      // failed WRITE never needs a re-run just to see what went wrong.
      persistLastError(doc);
      if (flags.json) {
        emitOutcome({ body: doc, exitCode }, emitOpts);
      } else {
        emitError(fields, exitCode, emitOpts);
      }
      process.exit(exitCode);
    }
  };
}

function errorDoc(fields: CliError['fields']): Record<string, unknown> {
  return {
    ok: false,
    error: {
      type: fields.type,
      code: fields.code,
      message: fields.message,
      ...(fields.hint !== undefined ? { hint: fields.hint } : {}),
      ...(fields.docUrl !== undefined ? { doc_url: fields.docUrl } : {}),
      ...(fields.requestId !== undefined ? { request_id: fields.requestId } : {}),
      ...(fields.retryable !== undefined ? { retryable: fields.retryable } : {}),
      ...(fields.retryAfterS !== undefined ? { retry_after_s: fields.retryAfterS } : {}),
      ...(fields.details !== undefined ? { details: fields.details } : {}),
    },
    meta: metaBlock(),
  };
}

function describeUnknown(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export { EXIT_INTERNAL };
