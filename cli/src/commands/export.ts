/** `moda export` — sync-then-poll export with transparent polling (cli.md §12). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import type { ApiClient } from '../api/client.ts';
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
      .option('--pages <ranges>', 'page selection, e.g. 1-3,5')
      .option('--pixel-ratio <n>', 'pixel ratio 1-4 (raster formats)', (v: string) => Number.parseInt(v, 10))
      .option('--flatten', 'degrade PDF to raster')
      .option('--no-wait', 'do not poll; print the export id and exit 0'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const format = (opts.format as string).toLowerCase();
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
      const { client } = await authedClient(inv, EXPORT_BUDGET_MS);
      const ref = await resolveCanvasRef(args[0] as string, client);
      const started = await client.request({
        method: 'POST',
        path: endpoints.canvasExport(ref),
        body: {
          format,
          ...(typeof opts.pages === 'string' ? { pages: opts.pages } : {}),
          ...(typeof opts.pixelRatio === 'number' ? { pixel_ratio: opts.pixelRatio } : {}),
          ...(opts.flatten === true ? { flatten: true } : {}),
        },
        timeoutMs: 120_000,
      });
      const startBody = asObject(started.body);
      const exportId = str(startBody, 'export_id') ?? str(asObject(startBody.export), 'id') ?? str(startBody, 'id');

      if (opts.wait === false) {
        return {
          body: {
            ok: true,
            operation: 'canvas.export',
            export_id: exportId,
            status: exportStatusOf(startBody) ?? 'pending',
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
      const outPath = resolveOutputPath(opts.output as string | undefined, ref, format, inv);
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
          export_id: exportId,
          format,
          output: toStdout ? '-' : outPath,
          bytes: bytes.byteLength,
          usage: final.usage ?? { class: 'deterministic', metered_credits: 0 },
          meta: metaBlock({ requestId: started.requestId }),
        },
        human: (write) => write(`${format} → ${toStdout ? '(stdout)' : outPath} (${bytes.byteLength} bytes)`),
        exitCode: EXIT_OK,
        summaryToStderr: toStdout,
      };
    }),
  );
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

const DONE = new Set(['completed', 'succeeded', 'done', 'ready']);
const FAILED = new Set(['failed', 'error', 'cancelled']);

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
      throw new CliError({
        type: 'upstream_error',
        code: 'export_failed',
        message: `Export ${status}: ${str(body, 'message') ?? 'no detail'}.`,
        source: 'api',
      });
    }
    if (Date.now() > deadline) {
      throw new CliError({
        type: 'upstream_error',
        code: 'export_timeout',
        message: 'Export did not finish within the polling budget.',
        hint: exportId !== undefined ? `Check later: export id ${exportId}` : undefined,
        source: 'transport',
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    inv.note('export: polling…');
    const polled = await client.request({
      method: 'GET',
      path: endpoints.canvasExportStatus(ref),
      query: exportId !== undefined ? { export_id: exportId } : undefined,
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

function resolveOutputPath(output: string | undefined, ref: string, format: string, inv: Invocation): string {
  if (output !== undefined) return output;
  const dir = inv.context.outputDir.value ?? '.';
  return join(dir, `${ref}.${format}`);
}
