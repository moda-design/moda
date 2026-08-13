/**
 * `moda ask` — free advisory Q&A: a plain-text question about how to do something with Moda,
 * answered by Moda itself, grounded in the live tool surface. Answers cite the exact verbs
 * and skill references to use. Ask whenever unsure — before an unfamiliar kind of task, when
 * weighing approaches, or after a failed call; the lane is fast and never spends credits.
 *
 * Server contract (binding; the backend implements exactly this — ask-expert memo, PR C/G + v1.1):
 *   POST /v1/ask {question (<= 2000 chars), context? (<= 10000 chars),
 *                 session_id? (<= 64), brand_kit_ref? (<= 128)}
 *     → {answer, citations?, pointers?, required_reading?, session_id, usage: {class: "assisted", …}}
 * `usage.class` "assisted" is the honest free sub-class: a model ran, zero credits spent.
 * Citation entries are rendered tolerantly (strings, or objects naming verbs/references) —
 * the server owns their exact shape; --json passes the whole envelope through untouched.
 *
 * Sessions (v2): `session_id` is ALWAYS returned — minted server-side when the request carried
 * none — and binds to the minting principal. Follow-ups reuse it automatically from state so a
 * conversation just works; `--fresh` starts over and `--session <id>` continues a named one.
 * The server owns expiry (24h idle → typed 410 `session_expired`); this CLI never mirrors that
 * window, it just recovers from the typed answer. An id the server cannot resolve — unknown,
 * malformed, or another principal's — is the typed 404 `session_not_found`.
 *
 * Brand grounding (v1.1): `--brand <kit-id>` sends `brand_kit_ref` so the answer is grounded in
 * that kit's palette, fonts, tone, and imagery. Opt-in ONLY — never inferred, and deliberately
 * NOT defaulted from the `.moda/` brand context: asking without the flag asks with no brand.
 * An unresolvable ref is the typed 404 `brand_kit_not_found`; a key without the `brand_kits:read`
 * scope is a 403.
 *
 * Tolerant posture (#9292 class): this CLI can ship before the endpoint deploys — a BARE
 * route 404 (code `http_404`, no server error envelope) means the server predates /v1/ask
 * and fails typed with that truth; an envelope'd `not_found` passes through untouched.
 */
import type { Command } from 'commander';
import type { ApiClient, ApiResponse } from '../api/client.ts';
import { endpoints } from '../api/endpoints.ts';
import { asObject, str } from '../api/types.ts';
import { clearAskSession, readAskSession, writeAskSession } from '../config/state.ts';
import { CliError, rethrowRoutePredates } from '../cliError.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import type { CommandOutcome } from '../output/emit.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction } from './runtime.ts';

/** Generous over the server's 10s fail-fast generation budget plus transport retries. */
const ASK_TIMEOUT_MS = 30_000;

/** Server-side caps (cli contract: question <= 2000 chars, context <= 10000 chars). */
export const MAX_QUESTION_CHARS = 2_000;
export const MAX_CONTEXT_CHARS = 10_000;

/** Server-side caps on the v2/v1.1 fields — rejected as 422 upstream, so fail typed here first. */
export const MAX_SESSION_ID_CHARS = 64;
export const MAX_BRAND_REF_CHARS = 128;

export function registerAsk(program: Command): void {
  addGlobalFlags(
    program
      .command('ask <question...>')
      .description('ask Moda how to do something (free, fast) — plain-text question in, a cited answer naming the exact verbs and references out')
      .option('--context <text>', 'extra context for the question — e.g. the failing command and its error output')
      .option('--fresh', 'start a new session: ignore the remembered one, so this question carries no prior context')
      .option('--session <id>', 'continue a specific session id (from an earlier answer) instead of the remembered one')
      .option('--brand <brand>', 'brand kit ref — ground the answer in that kit (palette, fonts, tone); never applied unless passed'),
  )
    .addHelpText(
      'after',
      '\nExamples:\n  moda ask "how do I add a chart to page 2 of an existing deck?"\n' +
        '  moda ask "why did canvas edit fail with stale_revision?" --context "<the error envelope>"\n' +
        '  moda ask "which of those palettes fits a finance deck?" --brand bk_123\n\n' +
        'Ask early and often — whenever unsure of the best approach: before an unfamiliar kind of\n' +
        'task, when weighing two ways to do something, or after any failed call. Free, no credits.\n\n' +
        'Follow-ups keep context automatically — the last session is reused; --fresh to reset.\n' +
        '--brand <kit-id> grounds answers in a brand kit (moda brand list); never applied otherwise.\n\n' +
        'Not for: researching the web (moda web search) or account/billing changes (moda.app).\n',
    )
    .action(
      wrapAction(async (args, opts, cmd) => {
        const inv = buildInvocation(cmd);
        const { client, credential } = await authedClient(inv, ASK_TIMEOUT_MS);
        return performAsk(client, {
          question: args.join(' '),
          context: opts.context as string | undefined,
          fresh: opts.fresh === true,
          sessionId: opts.session as string | undefined,
          brand: opts.brand as string | undefined,
          // Sessions bind to the minting principal server-side, so the remembered id is scoped
          // to the same (host, org) account key the credential index uses. A MODA_API_KEY
          // credential carries no org and lands on `host/-`, so two env keys for different orgs
          // on one host share a slot — the server's principal check catches it and the recovery
          // lane below re-mints, which is cheaper and more honest than hashing keys onto disk.
          accountKey: `${new URL(inv.context.apiBase.value).host}/${credential.org ?? '-'}`,
          env: inv.env,
          note: inv.note,
        });
      }),
    );
}

export interface AskOptions {
  question: string;
  /** Optional context blob (the failing command, its error output, what you are building). */
  context?: string;
  /** `--session <id>`: continue this exact session instead of the remembered one. */
  sessionId?: string;
  /** `--fresh`: ignore the remembered session and start a new one. */
  fresh?: boolean;
  /** `--brand <ref>`: brand-kit grounding. Opt-in only — never inferred from context. */
  brand?: string;
  /** `host/org` key the remembered session is stored under; omit to disable persistence. */
  accountKey?: string;
  env?: NodeJS.ProcessEnv;
  /** Stderr notice sink (never stdout). */
  note?: (message: string) => void;
}

export async function performAsk(client: ApiClient, opts: AskOptions): Promise<CommandOutcome> {
  const question = opts.question.trim();
  if (question.length === 0) throw CliError.usage('Question is empty.');
  if (question.length > MAX_QUESTION_CHARS) {
    throw CliError.usage(`Question is ${question.length} chars — the cap is ${MAX_QUESTION_CHARS}. Ask the core question; carry the long details in --context.`);
  }
  if (opts.context !== undefined && opts.context.length > MAX_CONTEXT_CHARS) {
    throw CliError.usage(`--context is ${opts.context.length} chars — the cap is ${MAX_CONTEXT_CHARS}. Trim it to the failing command and its error output.`);
  }
  if (opts.fresh === true && opts.sessionId !== undefined) {
    throw CliError.usage('--fresh and --session are contradictory: one starts a new session, the other continues a named one.');
  }
  if (opts.sessionId !== undefined && opts.sessionId.length > MAX_SESSION_ID_CHARS) {
    throw CliError.usage(`--session is ${opts.sessionId.length} chars — the cap is ${MAX_SESSION_ID_CHARS}. Pass a session_id from an earlier answer.`);
  }
  if (opts.brand !== undefined && opts.brand.length > MAX_BRAND_REF_CHARS) {
    throw CliError.usage(`--brand is ${opts.brand.length} chars — the cap is ${MAX_BRAND_REF_CHARS}. Pass a brand-kit id from moda brand list.`);
  }

  const env = opts.env ?? process.env;
  const remembered = opts.accountKey !== undefined && opts.fresh !== true && opts.sessionId === undefined
    ? readAskSession(opts.accountKey, env)
    : undefined;
  // An explicit --session wins over the remembered one; --fresh suppresses both.
  const sessionId = opts.sessionId ?? remembered;

  let response = await ask(client, opts, question, sessionId).catch((err: unknown) => {
    // A session the server no longer honours is recoverable, not fatal: retry ONCE without it.
    // Only the remembered id retries on `not_found` — an id the caller typed is theirs to fix,
    // and silently answering from a different conversation would hide that. Expiry (410) always
    // retries: it is the clock, not the caller, and the whole point of remembering is that the
    // caller never has to think about the window.
    const stale = staleSessionKind(err, sessionId !== undefined && sessionId === remembered);
    if (stale === undefined) throw err;
    if (opts.accountKey !== undefined) clearAskSession(opts.accountKey, env);
    opts.note?.(stale === 'expired'
      ? 'previous ask session expired — started a new one'
      : 'previous ask session is no longer available — started a new one');
    return ask(client, opts, question, undefined);
  });

  const root = asObject(response.body);
  // Persist whatever session the server answered under (minted or echoed) so the NEXT question
  // continues this one. A server predating v2 returns none — leave the store untouched.
  const answeredSession = str(root, 'session_id');
  if (opts.accountKey !== undefined && answeredSession !== undefined && answeredSession.length > 0) {
    writeAskSession(opts.accountKey, answeredSession, env);
  }

  return {
    body: {
      ok: true,
      ...root,
      operation: 'ask',
      meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
    },
    human: (write) => {
      const answer = str(root, 'answer');
      // The answer is the point — render it verbatim. A shape this CLI predates degrades to
      // the raw envelope rather than hiding a served answer.
      if (answer !== undefined && answer.trim().length > 0) write(answer);
      else write(JSON.stringify(root, null, 2));
      writeEntryBlock(write, 'Cited:', root.citations);
      writeEntryBlock(write, 'Read first:', root.required_reading);
      writeEntryBlock(write, 'See also:', root.pointers);
    },
    exitCode: EXIT_OK,
  };
}

/** One POST. Free lane: no idempotency key (nothing to re-bill) — a transport-retried POST just re-asks. */
function ask(
  client: ApiClient,
  opts: AskOptions,
  question: string,
  sessionId: string | undefined,
): Promise<ApiResponse<unknown>> {
  return client
    .request({
      method: 'POST',
      path: endpoints.ask(),
      body: {
        question,
        ...(opts.context !== undefined ? { context: opts.context } : {}),
        ...(sessionId !== undefined ? { session_id: sessionId } : {}),
        ...(opts.brand !== undefined ? { brand_kit_ref: opts.brand } : {}),
      },
    })
    .catch((err: unknown) => {
      if (opts.brand !== undefined) rethrowBrandKitHint(err);
      return rethrowRoutePredates(
        err,
        'This server predates the ask endpoint.',
        'It ships with the next backend deploy. Meanwhile: moda describe <verb> --json answers schema questions, and the skill references cover the workflows.',
      );
    });
}

/**
 * Why a session id failed, when that failure is one this CLI may silently recover from.
 *
 * The typed code is the discriminator: `session_expired` (410) and `session_not_found` (404),
 * both `retryable: false` in the server's catalogue. The message match behind it is the
 * compatibility lane for a server deployed before studio #9557 typed these — back then an
 * unknown session, a missing brand kit, and the route's own flag gate ALL enveloped as the
 * generic `not_found`, so the server's own wording ("Unknown session_id…") was the only signal.
 * A bare route 404 is code `http_404`, never `not_found`, so the server-predates lane cannot be
 * mistaken for either.
 */
function staleSessionKind(err: unknown, retryUnknown: boolean): 'expired' | 'unknown' | undefined {
  if (!(err instanceof CliError)) return undefined;
  const { code, message } = err.fields;
  if (code === 'session_expired') return 'expired';
  if (!retryUnknown) return undefined;
  if (code === 'session_not_found') return 'unknown';
  if (code === 'not_found' && message.toLowerCase().includes('session_id')) return 'unknown';
  return undefined;
}

/**
 * Name the fix for a --brand call's kit failures: `brand_kit_not_found` (404 — a foreign,
 * deleted, or gate-hidden ref all read identically by design) and the `brand_kits:read` scope
 * 403. The generic `not_found` + message match behind the typed code is the same pre-#9557
 * compatibility lane as the session codes above.
 */
function rethrowBrandKitHint(err: unknown): void {
  if (!(err instanceof CliError) || err.fields.hint !== undefined) return;
  const { code, message } = err.fields;
  if (code === 'brand_kit_not_found' || (code === 'not_found' && message.toLowerCase().includes('brand kit'))) {
    throw new CliError({ ...err.fields, hint: 'List the kits you can reach with: moda brand list' });
  }
  if (code === 'permission' && message.includes('brand_kits:read')) {
    throw new CliError({ ...err.fields, hint: 'This API key cannot read brand kits — ask without --brand, or issue a key with the brand_kits:read scope.' });
  }
}

/** Fields a citation/pointer entry is expected to carry, in display order. */
const ENTRY_FIELDS = ['verb', 'tool', 'skill', 'reference', 'pointer', 'doc', 'url', 'quote', 'note'] as const;

/** One display line per citation/pointer entry — tolerant of strings and unknown object shapes. */
export function renderEntry(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return JSON.stringify(entry);
  const obj = asObject(entry);
  const parts = ENTRY_FIELDS.map((field) => str(obj, field)).filter((value): value is string => value !== undefined && value.length > 0);
  return parts.length > 0 ? parts.join(' — ') : JSON.stringify(entry);
}

function writeEntryBlock(write: (line: string) => void, heading: string, value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) return;
  write('');
  write(heading);
  for (const entry of value) write(`  - ${renderEntry(entry)}`);
}
