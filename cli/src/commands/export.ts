/** `moda export` — sync-then-poll export with transparent polling (cli.md §12). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import type { ApiClient } from '../api/client.ts';
import type { CommandOutcome } from '../output/emit.ts';
import { endpoints } from '../api/endpoints.ts';
import { asObject, str } from '../api/types.ts';
import { CliError } from '../cliError.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction, type Invocation } from './runtime.ts';
import { resolveCanvasRef } from './canvasShared.ts';

const SUPPORTED_FORMATS = new Set(['pdf', 'pptx', 'png', 'jpeg']);
const ANIMATION_FORMATS = new Set(['gif', 'mp4', 'webp']);
const EXPORT_BUDGET_MS = 300_000;

export function registerExport(program: Command): void {
  addGlobalFlags(
    program
      .command('export <canvas>')
      .description('export a canvas (pdf|pptx|png|jpeg); polls transparently and downloads to -o')
      .requiredOption('--format <format>', 'pdf | pptx | png | jpeg')
      .option('-o, --output <path>', 'output path (default <canvas>.<ext> in the output dir)')
      .option('--page <n>', 'single 1-indexed page to export (omit for all pages; multi-page png/jpeg arrive as a zip)', (v: string) => Number.parseInt(v, 10))
      .option('--pixel-ratio <n>', 'pixel ratio 1-4 (raster formats)', (v: string) => Number.parseInt(v, 10))
      .option('--flatten', 'PDF only: degrade to raster (default is a selectable vector PDF)')
      .option('--no-wait', 'do not poll; print the export task id and exit 0'),
  )
    .addHelpText(
      'after',
      '\nExamples:\n  moda export cvs_123 --format pptx -o deck.pptx\n  moda export cvs_123 --format png --pixel-ratio 2 -o post.png\n\nNot for: quick visual checks while designing (moda canvas screenshot).\nAnimated formats (gif/mp4/webp) have no lane here — say so instead of\nretrying. PDF flattens hyperlinks to text.\n',
    )
    .action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, EXPORT_BUDGET_MS);
      const ref = await resolveCanvasRef(args[0] as string, client);
      return performExport(client, inv, ref, {
        format: (opts.format as string).toLowerCase(),
        output: opts.output as string | undefined,
        pageNumber: opts.page as number | undefined,
        pixelRatio: opts.pixelRatio as number | undefined,
        flatten: opts.flatten === true,
        wait: opts.wait !== false,
      });
    }),
  );
}

export interface ExportOptions {
  format: string;
  output?: string;
  /** Single 1-indexed page; the server has no range selection. */
  pageNumber?: number;
  pixelRatio?: number;
  flatten?: boolean;
  wait: boolean;
}

/** Start-poll-download an export. Shared by `moda export` and `moda task start --export`. */
export async function performExport(
  client: ApiClient,
  inv: Invocation,
  ref: string,
  options: ExportOptions,
): Promise<CommandOutcome> {
  const format = options.format;
  if (ANIMATION_FORMATS.has(format)) {
    throw new CliError({
      type: 'unprocessable',
      code: 'unsupported_export',
      message: `Animation export (${format}) has no server lane yet.`,
      hint: 'Export gif/mp4/webp from the Moda app; supported here: pdf, pptx, png, jpeg.',
      source: 'local',
    });
  }
  if (!SUPPORTED_FORMATS.has(format)) {
    throw CliError.usage(`Unsupported --format '${format}'.`, 'Supported: pdf, pptx, png, jpeg.');
  }
  // Server contract: POST /v1/canvases/{id}/export takes QUERY params (format, page_number,
  // pixel_ratio, flatten, wait), not a JSON body. flatten defaults to True server-side, so
  // pass it explicitly — the CLI default is a selectable vector PDF.
  const started = await client.request({
    method: 'POST',
    path: endpoints.canvasExport(ref),
    query: {
      format,
      ...(options.pageNumber !== undefined ? { page_number: String(options.pageNumber) } : {}),
      ...(options.pixelRatio !== undefined ? { pixel_ratio: String(options.pixelRatio) } : {}),
      flatten: options.flatten === true ? 'true' : 'false',
      wait: options.wait ? 'true' : 'false',
    },
    timeoutMs: 120_000,
  });
  const startBody = asObject(started.body);
  const exportId = str(startBody, 'task_id') ?? str(asObject(startBody.export), 'id') ?? str(startBody, 'id');

  if (!options.wait) {
    return {
      body: {
        ok: true,
        operation: 'canvas.export',
        task_id: exportId,
        status: exportStatusOf(startBody) ?? 'in_progress',
        usage: startBody.usage ?? { class: 'deterministic', metered_credits: 0 },
        meta: metaBlock({ requestId: started.requestId, durationMs: started.durationMs }),
      },
      human: (write) => write(`export started: ${exportId ?? '(id unknown)'}`),
      exitCode: EXIT_OK,
    };
  }

  const final = await pollExport(client, ref, exportId, startBody, inv);
  const downloadUrl = downloadUrlOf(final);
  if (downloadUrl === undefined) {
    throw new CliError({
      type: 'upstream_error',
      code: 'export_failed',
      message: 'Export finished without a downloadable artifact.',
      source: 'api',
    });
  }
  // The server reports what was ACTUALLY delivered: multi-page png/jpeg arrive bundled as a
  // zip, and the status body's `format` says so. Name the file and the envelope by that truth.
  const deliveredFormat = str(final, 'format') ?? str(asObject(final.export), 'format') ?? format;
  const outPath = resolveOutputPath(options.output, ref, deliveredFormat, options.pageNumber, inv);
  const bytes = await downloadArtifact(client, downloadUrl, inv);
  const toStdout = outPath === '-';
  if (toStdout) {
    process.stdout.write(bytes);
  } else {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, bytes);
  }
  return {
    body: {
      ok: true,
      operation: 'canvas.export',
      task_id: exportId,
      requested_format: format,
      delivered_format: deliveredFormat,
      output: toStdout ? '-' : outPath,
      bytes: bytes.byteLength,
      // Format truth the caller must not oversell (verified against the export pipeline).
      ...(format === 'pdf' ? { notes: ['hyperlinks are flattened to text in PDF output'] } : {}),
      usage: final.usage ?? { class: 'deterministic', metered_credits: 0 },
      meta: metaBlock({ requestId: started.requestId }),
    },
    human: (write) => {
      if (deliveredFormat !== format) {
        write(
          `requested ${format}, delivered ${deliveredFormat} (multi-page raster exports bundle as a zip of images)`,
        );
      }
      write(`${deliveredFormat} -> ${toStdout ? '(stdout)' : outPath} (${bytes.byteLength} bytes)`);
    },
    exitCode: EXIT_OK,
    summaryToStderr: toStdout,
  };
}

function exportStatusOf(body: Record<string, unknown>): string | undefined {
  return str(body, 'status') ?? str(asObject(body.export), 'status');
}

function downloadUrlOf(body: Record<string, unknown>): string | undefined {
  return (
    str(body, 'download_url') ??
    str(body, 'artifact_url') ??
    str(body, 'url') ??
    str(asObject(body.export), 'download_url') ??
    str(asObject(body.export), 'url')
  );
}

// Server statuses: export → 'completed' | 'in_progress'; export-status → 'queued' | 'running' | 'completed' | 'failed'.
const DONE = new Set(['completed']);
const FAILED = new Set(['failed']);

async function pollExport(
  client: ApiClient,
  ref: string,
  exportId: string | undefined,
  startBody: Record<string, unknown>,
  inv: Invocation,
): Promise<Record<string, unknown>> {
  let body = startBody;
  const deadline = Date.now() + (inv.flags.timeout !== undefined ? inv.flags.timeout * 1000 : EXPORT_BUDGET_MS);
  for (;;) {
    const status = exportStatusOf(body);
    if (downloadUrlOf(body) !== undefined || (status !== undefined && DONE.has(status))) return body;
    if (status !== undefined && FAILED.has(status)) {
      // Terminal: the render failed on final content — an identical re-run fails identically.
      // Honor a server-envelope retryable override when the status body carries one.
      throw new CliError({
        type: 'upstream_error',
        code: 'export_failed',
        message: `Export ${status}: ${str(body, 'error') ?? str(body, 'message') ?? 'no detail'}.`,
        hint: 'do not retry — identical re-runs fail identically; deliver the share link + screenshots instead',
        retryable: typeof body.retryable === 'boolean' ? body.retryable : false,
        source: 'api',
      });
    }
    if (exportId === undefined) {
      throw new CliError({
        type: 'upstream_error',
        code: 'export_failed',
        message: 'Export is in progress but the server returned no task_id to poll.',
        source: 'api',
      });
    }
    if (Date.now() > deadline) {
      throw new CliError({
        type: 'upstream_error',
        code: 'export_timeout',
        message: 'Export did not finish within the polling budget.',
        hint: `Check later: export task id ${exportId}`,
        source: 'transport',
      });
    }
    // Server contract: GET .../export-status?task_id=... (task_id is required).
    const hint = body.retry_after_seconds;
    await new Promise((resolve) => setTimeout(resolve, typeof hint === 'number' ? hint * 1000 : 1_500));
    inv.note('export: polling…');
    const polled = await client.request({
      method: 'GET',
      path: endpoints.canvasExportStatus(ref),
      query: { task_id: exportId },
      timeoutMs: 30_000,
    });
    body = asObject(polled.body);
  }
}

/**
 * Download the artifact. Same-origin paths go through the authed client; absolute (signed)
 * URLs are fetched bare — the API key must never be sent to a third-party host.
 */
async function downloadArtifact(client: ApiClient, downloadUrl: string, inv: Invocation): Promise<Uint8Array> {
  const isAbsolute = downloadUrl.startsWith('http://') || downloadUrl.startsWith('https://');
  const sameOrigin = isAbsolute && new URL(downloadUrl).origin === new URL(inv.context.apiBase.value).origin;
  if (!isAbsolute || sameOrigin) {
    const artifact = await client.request({ method: 'GET', path: downloadUrl, raw: true, timeoutMs: 120_000 });
    return artifact.bytes ?? new Uint8Array();
  }
  const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new CliError({
      type: 'upstream_error',
      code: 'export_failed',
      message: `Artifact download failed (HTTP ${response.status}).`,
      source: 'transport',
    });
  }
  return new Uint8Array(await response.arrayBuffer());
}

function resolveOutputPath(
  output: string | undefined,
  ref: string,
  format: string,
  pageNumber: number | undefined,
  inv: Invocation,
): string {
  if (output !== undefined) return output;
  const dir = inv.context.outputDir.value ?? '.';
  // Per-page exports carry the page number so a per-page loop cannot clobber its own files.
  return join(dir, `${ref}${pageNumber !== undefined ? `.p${pageNumber}` : ''}.${format}`);
}
