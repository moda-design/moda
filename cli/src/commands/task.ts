/** `moda task` — job status and collection: background renders and app-started design tasks. */
import type { Command } from 'commander';
import type { ApiClient } from '../api/client.ts';
import { endpoints } from '../api/endpoints.ts';
import { asObject, str, type JsonObject } from '../api/types.ts';
import { CliError } from '../cliError.ts';
import { LIST_ALL_CAP, fetchListPages, listFlagsOf, listOutcome, parseListLimit, parseListOffset } from './listLane.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import { parseRef } from '../refs.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction, type Invocation } from './runtime.ts';
import { passthroughOutcome } from './canvasShared.ts';

const REQUEST_TIMEOUT_MS = 60_000;
const WAIT_BUDGET_MS = 30 * 60 * 1000;
// Server taxonomy (PublicTaskStatus): queued | running | succeeded | failed | canceled | expired.
const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'expired']);

/** Max prompt characters on a list line — enough to tell two tasks apart, short enough to scan. */
const TASK_EXCERPT_MAX = 72;

/**
 * One list line per task. A bare `id  status` identifies nothing on an account with thousands of
 * tasks, so lead with an excerpt of the prompt that started it — the only human-meaningful field
 * the payload carries — and push kind/status/date into the facet bracket (template-list idiom).
 */
function taskLine(item: JsonObject): string {
  const facets: string[] = [];
  const kind = str(item, 'kind');
  if (kind !== undefined) facets.push(kind);
  const status = str(item, 'status');
  if (status !== undefined) facets.push(status);
  const created = str(item, 'created_at');
  if (created !== undefined) facets.push(created.slice(0, 10));
  const prompt = str(asObject(item.input), 'prompt')?.replace(/\s+/g, ' ').trim();
  const excerpt =
    prompt === undefined || prompt.length === 0
      ? ''
      : prompt.length > TASK_EXCERPT_MAX
        ? `${prompt.slice(0, TASK_EXCERPT_MAX - 1)}…`
        : prompt;
  return `${str(item, 'id') ?? '?'}  ${excerpt}${facets.length > 0 ? `  [${facets.join(' · ')}]` : ''}`;
}

export function registerTask(program: Command): void {
  const task = program.command('task').description('job status and collection — background renders and app-started design tasks');

  addGlobalFlags(
    task
      .command('status <task>')
      .description('status + usage receipt for a task or a background video render')
      .option(
        '--wait',
        'poll until the status is terminal, streaming progress to stderr. A failed or canceled ' +
          'job still exits 0 — this verb reports, it does not adjudicate; read `status`',
      ),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, REQUEST_TIMEOUT_MS);
      const ref = parseRef(args[0] as string, 'task').ref;
      const first = await fetchJobStatus(client, ref);
      if (opts.wait !== true) return passthroughOutcome(first.operation, first.response, inv);
      const final = await waitForJob(client, ref, first, inv);
      const status = taskStatusOf(final.body);
      return {
        body: {
          ok: true,
          operation: first.operation,
          ...final.body,
          meta: { ...asObject(final.body.meta), ...metaBlock({ requestId: final.requestId }) },
        },
        human: (write) => {
          write(`${ref}: ${status ?? 'unknown'}`);
          const result = asObject(final.body.result);
          const fileId = str(result, 'id') ?? str(result, 'file_id') ?? str(result, 'canvas_id');
          if (fileId !== undefined) write(`result: ${fileId}`);
          const errorObj = asObject(final.body.error);
          const message = str(errorObj, 'message');
          if (message !== undefined) write(`error: ${message}`);
        },
        exitCode: EXIT_OK,
      };
    }),
  );

  addGlobalFlags(
    task
      .command('list')
      .description('list tasks')
      .option('--active', 'only running tasks')
      .option('--limit <n>', 'page size', parseListLimit)
      .option('--cursor <token>', "resume token from a previous page's next_cursor")
      .option('--all', `fetch every page (bounded at ${LIST_ALL_CAP} items)`)
      .option('--output <file>', 'write the full payload to a file; stdout gets a small summary + preview'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const flags = listFlagsOf(opts);
      const { client } = await authedClient(inv, REQUEST_TIMEOUT_MS);
      // Server contract: GET /v1/tasks?status=... (single status filter); cursor lane (#9317).
      const pages = await fetchListPages(
        client,
        endpoints.taskList(),
        opts.active === true ? { status: 'running' } : {},
        flags,
        REQUEST_TIMEOUT_MS,
        'cursor',
      );
      return listOutcome({
        operation: 'task.list',
        pages,
        flags,
        emptyHint: opts.active === true ? 'no running tasks — see all: moda task list' : 'no tasks yet',
        itemLine: taskLine,
      });
    }),
  );

  addGlobalFlags(task.command('cancel <task>').description('cancel a running task')).action(
    wrapAction(async (args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, REQUEST_TIMEOUT_MS);
      const ref = parseRef(args[0] as string, 'task').ref;
      const response = await client.request({ method: 'POST', path: endpoints.taskCancel(ref), body: {} });
      return passthroughOutcome('task.cancel', response, inv);
    }),
  );
}

function taskStatusOf(body: Record<string, unknown>): string | undefined {
  return str(body, 'status') ?? str(asObject(body.task), 'status');
}

interface JobStatusResponse {
  response: { body: unknown; requestId?: string; durationMs: number };
  /** Which lane answered — the two poll on different endpoints and report different operations. */
  operation: 'task.status' | 'media.generate-video';
}

/**
 * Resolve a `task_…` handle across the two lanes that mint one. The design lane owns /v1/tasks;
 * a background video render started with `moda media generate-video --no-wait` lives on the media
 * lane's own poll endpoint (studio #9603, the layerize precedent) and is invisible to /v1/tasks.
 *
 * The design lane is tried FIRST and its 404 is what routes to the media lane, so a real design
 * task never pays for the extra call — and when neither lane knows the id, the caller gets the
 * design lane's typed error rather than a media-shaped one for a handle that may not be a render.
 */
async function fetchJobStatus(client: ApiClient, ref: string): Promise<JobStatusResponse> {
  try {
    return { response: await client.request({ method: 'GET', path: endpoints.taskShow(ref) }), operation: 'task.status' };
  } catch (err) {
    if (!(err instanceof CliError) || err.fields.status !== 404) throw err;
    try {
      return {
        response: await client.request({ method: 'GET', path: endpoints.mediaVideoGenerationStatus(ref) }),
        operation: 'media.generate-video',
      };
    } catch (mediaErr) {
      // Both lanes answered "no such job" — including a server that predates the media poll
      // route entirely. The design lane's error is the honest one to surface.
      if (mediaErr instanceof CliError && mediaErr.fields.status === 404) throw err;
      throw mediaErr;
    }
  }
}

/**
 * Poll one job to a terminal status. Both lanes speak the same envelope — `status` in the
 * PublicTaskStatus vocabulary plus a `retry_after_ms` pacing hint — so one loop serves both; a
 * terminal render's hint is null, which is exactly when the loop stops reading it.
 */
async function waitForJob(
  client: ApiClient,
  ref: string,
  first: JobStatusResponse,
  inv: Invocation,
): Promise<{ body: Record<string, unknown>; requestId?: string }> {
  const path =
    first.operation === 'task.status' ? endpoints.taskShow(ref) : endpoints.mediaVideoGenerationStatus(ref);
  const deadline = Date.now() + (inv.flags.timeout !== undefined ? inv.flags.timeout * 1000 : WAIT_BUDGET_MS);
  let body = asObject(first.response.body);
  let requestId = first.response.requestId;
  let waitMs = 2_000;
  for (;;) {
    const status = taskStatusOf(body);
    if (status !== undefined && TERMINAL.has(status)) return { body, requestId };
    if (Date.now() > deadline) {
      throw new CliError({
        type: 'upstream_error',
        code: 'task_wait_timeout',
        message: `Job ${ref} did not reach a terminal status within the wait budget.`,
        hint: `Nothing is lost — poll again later: moda task status ${ref}`,
        source: 'transport',
      });
    }
    const hint = body.retry_after_ms;
    await new Promise((resolve) => setTimeout(resolve, typeof hint === 'number' ? hint : waitMs));
    waitMs = Math.min(waitMs * 1.5, 10_000);
    inv.note(`${ref}: ${status ?? 'running'}`);
    const polled = await client.request({ method: 'GET', path, timeoutMs: 30_000 });
    body = asObject(polled.body);
    requestId = polled.requestId ?? requestId;
  }
}

