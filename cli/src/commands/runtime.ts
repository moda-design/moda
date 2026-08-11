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
import { emitUpdateNotice } from '../update.ts';
import { CLI_VERSION } from '../version.ts';
import { API_VERSION_PIN } from '../api/endpoints.ts';

export interface GlobalFlags {
  json: boolean;
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
    .option('--json', 'machine output: exactly one JSON document on stdout; implies --no-input')
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
  const emitOpts: EmitOptions = { json: flags.json, quiet: flags.quiet };
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

/** Standard `meta` block on every --json document (cli.md §3). */
export function metaBlock(extra: { requestId?: string; durationMs?: number } = {}): Record<string, unknown> {
  return {
    ...(extra.requestId !== undefined ? { request_id: extra.requestId } : {}),
    ...(extra.durationMs !== undefined ? { duration_ms: extra.durationMs } : {}),
    cli_version: CLI_VERSION,
    api_version: API_VERSION_PIN,
  };
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
    const emitOpts: EmitOptions = { json: flags.json, quiet: flags.quiet };
    try {
      const outcome = await handler(positionals, opts, cmd);
      emitOutcome(outcome, { ...emitOpts, summaryToStderr: outcome.summaryToStderr === true });
      if (!flags.quiet) emitUpdateNotice(process.env);
      process.exit(outcome.exitCode);
    } catch (err) {
      const fields = err instanceof CliError ? err.fields : CliError.internal(describeUnknown(err)).fields;
      const exitCode = exitCodeForError(fields);
      if (flags.json) {
        emitOutcome({ body: errorDoc(fields), exitCode }, emitOpts);
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
