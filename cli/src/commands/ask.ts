/**
 * `moda ask` — free advisory Q&A: a plain-text question about how to do something with Moda,
 * answered by Moda itself, grounded in the live tool surface. Answers cite the exact verbs
 * and skill references to use. Ask whenever unsure — before an unfamiliar kind of task, when
 * weighing approaches, or after a failed call; the lane is fast and never spends credits.
 *
 * Server contract (binding; the backend implements exactly this — ask-expert memo, PR C):
 *   POST /v1/ask {question (<= 2000 chars), context? (<= 10000 chars)}
 *     → {answer, citations?: […], usage: {class: "assisted", metered_credits: 0}, …}
 * `usage.class` "assisted" is the honest free sub-class: a model ran, zero credits spent.
 * Citation entries are rendered tolerantly (strings, or objects naming verbs/references) —
 * the server owns their exact shape; --json passes the whole envelope through untouched.
 *
 * Tolerant posture (#9292 class): this CLI can ship before the endpoint deploys — a BARE
 * route 404 (code `http_404`, no server error envelope) means the server predates /v1/ask
 * and fails typed with that truth; an envelope'd `not_found` passes through untouched.
 */
import type { Command } from 'commander';
import type { ApiClient } from '../api/client.ts';
import { endpoints } from '../api/endpoints.ts';
import { asObject, str } from '../api/types.ts';
import { CliError, rethrowRoutePredates } from '../cliError.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import type { CommandOutcome } from '../output/emit.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction } from './runtime.ts';

/** Generous over the server's 10s fail-fast generation budget plus transport retries. */
const ASK_TIMEOUT_MS = 30_000;

/** Server-side caps (cli contract: question <= 2000 chars, context <= 10000 chars). */
export const MAX_QUESTION_CHARS = 2_000;
export const MAX_CONTEXT_CHARS = 10_000;

export function registerAsk(program: Command): void {
  addGlobalFlags(
    program
      .command('ask <question...>')
      .description('ask Moda how to do something (free, fast) — plain-text question in, a cited answer naming the exact verbs and references out')
      .option('--context <text>', 'extra context for the question — e.g. the failing command and its error output'),
  )
    .addHelpText(
      'after',
      '\nExamples:\n  moda ask "how do I add a chart to page 2 of an existing deck?"\n' +
        '  moda ask "why did canvas edit fail with stale_revision?" --context "<the error envelope>"\n\n' +
        'Ask early and often — whenever unsure of the best approach: before an unfamiliar kind of\n' +
        'task, when weighing two ways to do something, or after any failed call. Free, no credits.\n\n' +
        'Not for: researching the web (moda web search) or account/billing changes (moda.app).\n',
    )
    .action(
      wrapAction(async (args, opts, cmd) => {
        const inv = buildInvocation(cmd);
        const { client } = await authedClient(inv, ASK_TIMEOUT_MS);
        return performAsk(client, { question: args.join(' '), context: opts.context as string | undefined });
      }),
    );
}

export interface AskOptions {
  question: string;
  /** Optional context blob (the failing command, its error output, what you are building). */
  context?: string;
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
  // Free lane: no idempotency key (nothing to re-bill) — a transport-retried POST just re-asks.
  const response = await client
    .request({
      method: 'POST',
      path: endpoints.ask(),
      body: { question, ...(opts.context !== undefined ? { context: opts.context } : {}) },
    })
    .catch((err: unknown) =>
      rethrowRoutePredates(
        err,
        'This server predates the ask endpoint.',
        'It ships with the next backend deploy. Meanwhile: moda describe <verb> --json answers schema questions, and the skill references cover the workflows.',
      ),
    );
  const root = asObject(response.body);
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
      writeEntryBlock(write, 'See also:', root.pointers);
    },
    exitCode: EXIT_OK,
  };
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
