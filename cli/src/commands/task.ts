/** `moda task` — the metered Omni escalation lane (cli.md §10). Never an invisible fallback. */
import type { Command } from 'commander';
import type { ApiClient } from '../api/client.ts';
import { endpoints } from '../api/endpoints.ts';
import { asObject, str } from '../api/types.ts';
import { CliError } from '../cliError.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import { parseRef } from '../refs.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction, type Invocation } from './runtime.ts';
import { passthroughOutcome, resolveCanvasRef } from './canvasShared.ts';
import { performExport } from './export.ts';

const START_TIMEOUT_MS = 60_000;
const WAIT_BUDGET_MS = 30 * 60 * 1000;
const TERMINAL = new Set(['completed', 'succeeded', 'done', 'failed', 'error', 'cancelled']);
const FAILED = new Set(['failed', 'error', 'cancelled']);

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
      .option('--wait', 'poll until the task completes, streaming progress to stderr')
      .option('--export <format>', 'chain an export on completion (implies --wait)')
      .option('-o, --output <path>', 'output path for the chained export')
      .option('--callback-url <url>', 'CI callback (server-side validated)'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, START_TIMEOUT_MS);
      const canvasRef = typeof opts.canvas === 'string' ? await resolveCanvasRef(opts.canvas, client) : undefined;
      const payload = {
        prompt: opts.prompt as string,
        ...(canvasRef !== undefined ? { canvas_id: canvasRef } : {}),
        ...(Array.isArray(opts.files) ? { file_ids: opts.files as string[] } : {}),
        ...(typeof opts.brand === 'string' ? { brand_id: parseRef(opts.brand, 'brand_kit').ref } : {}),
        ...(typeof opts.format === 'string' ? { format: opts.format } : {}),
        ...(typeof opts.callbackUrl === 'string' ? { callback_url: opts.callbackUrl } : {}),
      };
      const started = await client.request({
        method: 'POST',
        path: endpoints.taskStart(),
        body: payload,
        idempotency: {
          command: 'task start',
          canvas: canvasRef ?? '',
          expectedRevision: undefined,
          payload: JSON.stringify(payload),
        },
      });
      const startBody = asObject(started.body);
      const taskId = str(startBody, 'task_id') ?? str(asObject(startBody.task), 'id') ?? str(startBody, 'id');
      const wantExport = typeof opts.export === 'string';
      const shouldWait = opts.wait === true || wantExport;

      if (!shouldWait || taskId === undefined) {
        return {
          body: {
            ok: true,
            operation: 'task.start',
            metered: true,
            ...startBody,
            meta: { ...asObject(startBody.meta), ...metaBlock({ requestId: started.requestId, durationMs: started.durationMs }) },
          },
          human: (write) => write(`task ${taskId ?? '?'} started (metered) — poll: moda task status ${taskId ?? ''}`),
          exitCode: EXIT_OK,
        };
      }

      const finalBody = await waitForTask(client, taskId, inv);
      const status = taskStatusOf(finalBody);
      if (status !== undefined && FAILED.has(status)) {
        throw new CliError({
          type: 'upstream_error',
          code: 'task_failed',
          message: `Task ${taskId} ${status}: ${str(finalBody, 'message') ?? 'no detail'}.`,
          source: 'api',
        });
      }

      if (wantExport) {
        const exportCanvas =
          str(asObject(finalBody.canvas), 'id') ?? str(finalBody, 'canvas_id') ?? canvasRef;
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
      .option('--active', 'only running tasks'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, START_TIMEOUT_MS);
      const response = await client.request({
        method: 'GET',
        path: endpoints.taskList(),
        query: opts.active === true ? { active: 'true' } : undefined,
      });
      return passthroughOutcome('task.list', response, inv);
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
    const progress = str(body, 'progress') ?? str(body, 'phase');
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
    // Server-paced backoff: honor a retry hint when present, otherwise ramp to 10s.
    const hint = asObject(body).retry_after_s;
    const sleepMs = typeof hint === 'number' ? hint * 1000 : waitMs;
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
    waitMs = Math.min(waitMs * 1.5, 10_000);
  }
}
