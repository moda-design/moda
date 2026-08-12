/** `moda task` — the metered Omni escalation lane (cli.md §10). Never an invisible fallback. */
import type { Command } from 'commander';
import type { ApiClient } from '../api/client.ts';
import { endpoints } from '../api/endpoints.ts';
import { deriveIdempotencyKey } from '../api/idempotency.ts';
import { asObject, str } from '../api/types.ts';
import { CliError } from '../cliError.ts';
import { readTaskStart, recordTaskStart, recordTaskStatus, type TaskStartEntry } from '../config/state.ts';
import { LIST_ALL_CAP, fetchListPages, listFlagsOf, listOutcome, parseListLimit, parseListOffset } from './listLane.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import { parseRef } from '../refs.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction, type Invocation } from './runtime.ts';
import { passthroughOutcome, resolveCanvasRef } from './canvasShared.ts';
import { performExport } from './export.ts';

const START_TIMEOUT_MS = 60_000;
const WAIT_BUDGET_MS = 30 * 60 * 1000;
// Server taxonomy (PublicTaskStatus): queued | running | succeeded | failed | canceled | expired.
const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'expired']);
const FAILED = new Set(['failed', 'canceled', 'expired']);

/** FormatInput.category enum on StartTaskRequest; anything else travels as a free-text label. */
const FORMAT_CATEGORIES = new Set([
  'slides', 'social', 'carousel', 'pdf', 'diagram', 'ui', 'animation', 'prints', 'web-ads', 'other',
]);

export function registerTask(program: Command): void {
  const task = program.command('task').description('Omni escalation lane — metered, labeled, explicit');

  addGlobalFlags(
    task
      .command('start')
      .description('start an Omni task (spends Moda credits; cost class before, receipt after)')
      .requiredOption('--prompt <prompt>', 'the task prompt')
      .option('--canvas <canvas>', 'target canvas')
      .option('--files <file_ids...>', 'input file refs')
      .option('--brand <brand>', 'brand kit ref')
      .option('--format <format>', 'output format hint (slides | one-pager | social | …)')
      .option('--fresh', 'force a NEW task: salt the idempotency key instead of replaying an identical earlier start')
      .option('--wait', 'poll until the task completes, streaming progress to stderr')
      .option('--export <format>', 'chain an export on completion (implies --wait)')
      .option('-o, --output <path>', 'output path for the chained export')
      .option('--callback-url <url>', 'CI callback (server-side validated)'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, START_TIMEOUT_MS);
      const canvasRef = typeof opts.canvas === 'string' ? await resolveCanvasRef(opts.canvas, client) : undefined;
      // Server contract (StartTaskRequest): brand_kit_id, attachments ({file_id, role}),
      // format as a FormatInput object. `role: 'asset'` = place the file in the design.
      const format = typeof opts.format === 'string' ? opts.format : undefined;
      const payload = {
        prompt: opts.prompt as string,
        ...(canvasRef !== undefined ? { canvas_id: canvasRef } : {}),
        ...(Array.isArray(opts.files)
          ? { attachments: (opts.files as string[]).map((fileId) => ({ file_id: fileId, role: 'asset' })) }
          : {}),
        ...(typeof opts.brand === 'string' ? { brand_kit_id: parseRef(opts.brand, 'brand_kit').ref } : {}),
        ...(format !== undefined
          ? { format: FORMAT_CATEGORIES.has(format) ? { category: format } : { label: format } }
          : {}),
        ...(typeof opts.callbackUrl === 'string' ? { callback_url: opts.callbackUrl } : {}),
      };
      // The server sends NO replayed flag on task.start, so replay loudness is CLI-side: the
      // derived key is checked against a local start ledger. --fresh salts the key for a
      // deliberately new attempt (the escape after task_failed).
      const idempotencyParts = {
        command: 'task start',
        canvas: canvasRef ?? '',
        expectedRevision: undefined,
        payload: JSON.stringify(payload) + (opts.fresh === true ? `#fresh:${crypto.randomUUID()}` : ''),
      };
      const derivedKey = deriveIdempotencyKey(idempotencyParts);
      const priorStart = readTaskStart(derivedKey, inv.env);
      const callStartedAt = Date.now();
      const started = await client.request({
        method: 'POST',
        path: endpoints.taskStart(),
        body: payload,
        idempotency: idempotencyParts,
      });
      const startBody = asObject(started.body);
      // Server contract: the response is the canonical Task envelope — `id` is the task_... id.
      const taskId = str(startBody, 'id') ?? str(startBody, 'task_id') ?? str(asObject(startBody.task), 'id');
      let replayedLocally = false;
      if (taskId !== undefined) {
        const createdAtMs = Date.parse(str(startBody, 'created_at') ?? '');
        const serverNowMs = Date.parse(started.headers.get('date') ?? '');
        const verdict = detectStartReplay({
          taskId,
          fresh: opts.fresh === true,
          prior: priorStart,
          createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : undefined,
          serverNowMs: Number.isFinite(serverNowMs) ? serverNowMs : undefined,
          localNowMs: callStartedAt,
        });
        replayedLocally = verdict.replayed;
        if (verdict.note !== undefined) inv.note(verdict.note);
        if (verdict.record) {
          recordTaskStart(derivedKey, { task_id: taskId, started_at: new Date().toISOString() }, inv.env);
        }
      }
      const wantExport = typeof opts.export === 'string';
      const shouldWait = opts.wait === true || wantExport;

      if (!shouldWait || taskId === undefined) {
        return {
          body: {
            ok: true,
            operation: 'task.start',
            metered: true,
            ...startBody,
            ...(replayedLocally ? { replayed: true } : {}),
            meta: { ...asObject(startBody.meta), ...metaBlock({ requestId: started.requestId, durationMs: started.durationMs }) },
          },
          human: (write) =>
            write(
              `task ${taskId ?? '?'} ${replayedLocally ? 'replayed (already started)' : 'started'} (metered)` +
                ` — poll: moda task status ${taskId ?? ''}`,
            ),
          exitCode: EXIT_OK,
        };
      }

      const finalBody = await waitForTask(client, taskId, inv);
      const status = taskStatusOf(finalBody);
      if (status !== undefined) recordTaskStatus(taskId, status, inv.env);
      if (status !== undefined && FAILED.has(status)) {
        const errorObj = asObject(finalBody.error);
        throw new CliError({
          type: 'upstream_error',
          code: 'task_failed',
          message: `Task ${taskId} ${status}: ${str(errorObj, 'message') ?? str(finalBody, 'message') ?? 'no detail'}.`,
          hint: 'Re-running the identical command replays this same failed task — start a new attempt with --fresh.',
          source: 'api',
        });
      }

      if (wantExport) {
        const exportCanvas =
          str(asObject(finalBody.result), 'canvas_id') ?? str(finalBody, 'canvas_id') ?? canvasRef;
        if (exportCanvas === undefined) {
          throw new CliError({
            type: 'unprocessable',
            code: 'export_failed',
            message: 'Task finished but no canvas id is available to export.',
            source: 'api',
          });
        }
        const exportOutcome = await performExport(client, inv, exportCanvas, {
          format: (opts.export as string).toLowerCase(),
          output: opts.output as string | undefined,
          wait: true,
        });
        return {
          body: {
            ok: true,
            operation: 'task.start',
            metered: true,
            task: finalBody,
            export: exportOutcome.body,
            meta: metaBlock({ requestId: started.requestId }),
          },
          exitCode: EXIT_OK,
        };
      }

      return {
        body: {
          ok: true,
          operation: 'task.start',
          metered: true,
          ...finalBody,
          meta: { ...asObject(finalBody.meta), ...metaBlock({ requestId: started.requestId }) },
        },
        exitCode: EXIT_OK,
      };
    }),
  );

  addGlobalFlags(task.command('status <task>').description('task status + usage receipt')).action(
    wrapAction(async (args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, START_TIMEOUT_MS);
      const ref = parseRef(args[0] as string, 'task').ref;
      const response = await client.request({ method: 'GET', path: endpoints.taskShow(ref) });
      return passthroughOutcome('task.status', response, inv);
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
      const { client } = await authedClient(inv, START_TIMEOUT_MS);
      // Server contract: GET /v1/tasks?status=... (single status filter); cursor lane (#9317).
      const pages = await fetchListPages(
        client,
        endpoints.taskList(),
        opts.active === true ? { status: 'running' } : {},
        flags,
        START_TIMEOUT_MS,
        'cursor',
      );
      return listOutcome({
        operation: 'task.list',
        pages,
        flags,
        emptyHint: opts.active === true ? 'no running tasks — see all: moda task list' : 'no tasks yet',
        itemLine: (item) => `${str(item, 'id') ?? '?'}  ${str(item, 'status') ?? ''}`,
      });
    }),
  );

  addGlobalFlags(task.command('cancel <task>').description('cancel a running task')).action(
    wrapAction(async (args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, START_TIMEOUT_MS);
      const ref = parseRef(args[0] as string, 'task').ref;
      const response = await client.request({ method: 'POST', path: endpoints.taskCancel(ref), body: {} });
      return passthroughOutcome('task.cancel', response, inv);
    }),
  );
}

export interface StartReplayVerdict {
  /** Confident replay CLAIM — ledger evidence or a server-clock (skew-free) predate. */
  replayed: boolean;
  /** Stderr line to emit: the claim, or the hedged possible-replay note. */
  note?: string;
  /** Record this start in the ledger? Never under --fresh: a salted key can never match again,
   *  and recording salted keys would evict the real entries (50-entry cap). */
  record: boolean;
}

/**
 * CLI-side replay detection for task.start (the server sends no replayed flag). The replay
 * CLAIM requires trustworthy evidence: a ledger match, or created_at predating the SERVER
 * Date-header time. The local clock alone is never trusted — a skewed-ahead client clock would
 * otherwise brand every start a replay and steer agents to --fresh, a real double charge on a
 * metered lane — so without server time the pure clock signal degrades to a hedged note.
 */
export function detectStartReplay(input: {
  taskId: string;
  fresh: boolean;
  prior?: TaskStartEntry;
  createdAtMs?: number;
  serverNowMs?: number;
  localNowMs: number;
}): StartReplayVerdict {
  const record = !input.fresh;
  if (input.prior !== undefined && input.prior.task_id === input.taskId) {
    return {
      replayed: true,
      note:
        `(replayed — an identical start already ran as task ${input.taskId}` +
        `${input.prior.last_status !== undefined ? `, last seen ${input.prior.last_status}` : ''}; ` +
        'pass --fresh for a new attempt)',
      record: false,
    };
  }
  if (input.createdAtMs !== undefined) {
    if (input.serverNowMs !== undefined) {
      if (input.createdAtMs < input.serverNowMs - 30_000) {
        return {
          replayed: true,
          note:
            `(task ${input.taskId} predates this call — an earlier identical start was replayed; ` +
            'pass --fresh for a new attempt)',
          record,
        };
      }
    } else if (input.createdAtMs < input.localNowMs - 30_000) {
      const seconds = Math.round((input.localNowMs - input.createdAtMs) / 1000);
      return {
        replayed: false,
        note: `(task ${input.taskId} predates this call by ${seconds}s — possible replay of an earlier identical start)`,
        record,
      };
    }
  }
  return { replayed: false, record };
}

function taskStatusOf(body: Record<string, unknown>): string | undefined {
  return str(body, 'status') ?? str(asObject(body.task), 'status');
}

async function waitForTask(client: ApiClient, taskId: string, inv: Invocation): Promise<Record<string, unknown>> {
  const deadline = Date.now() + (inv.flags.timeout !== undefined ? inv.flags.timeout * 1000 : WAIT_BUDGET_MS);
  let waitMs = 2_000;
  for (;;) {
    const response = await client.request({ method: 'GET', path: endpoints.taskShow(taskId), timeoutMs: 30_000 });
    const body = asObject(response.body);
    const status = taskStatusOf(body);
    // TaskProgress is {percent, step}; render whichever is present.
    const progressObj = asObject(body.progress);
    const step = str(progressObj, 'step');
    const percent = progressObj.percent;
    const progress = step ?? (typeof percent === 'number' ? `${percent}%` : undefined);
    inv.note(`task ${taskId}: ${status ?? 'running'}${progress !== undefined ? ` — ${progress}` : ''}`);
    if (status !== undefined && TERMINAL.has(status)) return body;
    if (Date.now() > deadline) {
      throw new CliError({
        type: 'upstream_error',
        code: 'task_wait_timeout',
        message: `Task ${taskId} did not finish within the wait budget.`,
        hint: `Poll later: moda task status ${taskId}`,
        source: 'transport',
      });
    }
    // Server-paced backoff: honor the Task envelope's retry_after_ms hint, otherwise ramp to 10s.
    const hint = asObject(body).retry_after_ms;
    const sleepMs = typeof hint === 'number' ? hint : waitMs;
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
    waitMs = Math.min(waitMs * 1.5, 10_000);
  }
}
