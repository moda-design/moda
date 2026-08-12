/**
 * Parity-register residue wave: export/screenshot warnings surfacing (G13), stock asset
 * sourcing (G11), and the `canvas show` guidance block (G16, canvas half).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ApiClient } from '../src/api/client.ts';
import { CliError } from '../src/cliError.ts';
import { performExport } from '../src/commands/export.ts';
import { attachScreenshotResult, captureAfterMutation } from '../src/commands/mutationScreenshot.ts';
import {
  captureWarningLines,
  mergeCaptureWarnings,
  writeScreenshotPages,
  type ScreenshotResponse,
} from '../src/commands/screenshotCapture.ts';
import type { Invocation } from '../src/commands/runtime.ts';
import type { CommandOutcome } from '../src/output/emit.ts';

const MAIN = resolve(import.meta.dir, '../src/main.ts');
const CVS = 'cvs_01HZX9K2ABCDEFGHJKMNPQRSTV';

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const jpegDataUrl = `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`;

let server: ReturnType<typeof Bun.serve> | undefined;

interface Captured {
  method: string;
  path: string;
  search: string;
}

function serve(respond: (req: Request, url: URL) => Response | Promise<Response>): { base: string; calls: Captured[] } {
  const calls: Captured[] = [];
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      calls.push({ method: req.method, path: url.pathname, search: url.search });
      return await respond(req, url);
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, calls };
}

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function client(base: string): ApiClient {
  return new ApiClient({
    apiBase: base,
    apiKey: 'moda_live_testkey000000',
    sleeper: async () => {},
    env: { MODA_STATE_DIR: '/tmp/moda-residue-test-state' },
  });
}

function fakeInv(base: string, outDir: string): Invocation {
  return {
    flags: { json: true, pretty: false, quiet: true, noInput: true, noRetry: false },
    context: { apiBase: { value: base }, org: { value: undefined }, outputDir: { value: outDir } },
    env: {},
    emitOpts: { json: true, quiet: true },
    note: () => {},
  } as unknown as Invocation;
}

function humanLines(outcome: CommandOutcome): string[] {
  const lines: string[] = [];
  outcome.human?.((line) => lines.push(line));
  return lines;
}

async function run(args: string[], base: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const scratch = mkdtempSync(join(tmpdir(), 'moda-residue-'));
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      MODA_NO_UPDATE_CHECK: '1',
      MODA_CONFIG_DIR: join(scratch, 'config'),
      MODA_STATE_DIR: join(scratch, 'state'),
      MODA_API_KEY: 'moda_live_testkey000000',
      MODA_API_BASE: base,
    },
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

const PPTX_WARNING = {
  code: 'pptx_shape_rasterized',
  message: '2 image(s) could not be embedded as native PowerPoint pictures; their pixels are baked into the slide background.',
  severity: 'warning',
  details: { dropped_image_count: 2 },
};

describe('G13: export warnings surfacing', () => {
  test('completed export: server warnings verbatim in --json, site.ts-style warning lines, no hardcoded note', async () => {
    const { base } = serve((req, url) => {
      if (url.pathname.endsWith('/export')) {
        return Response.json({
          task_id: 'exp_w',
          status: 'completed',
          format: 'pptx',
          download_url: '/dl/exp_w',
          warnings: [PPTX_WARNING],
        });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    const outDir = mkdtempSync(join(tmpdir(), 'moda-export-warn-'));
    const outcome = await performExport(client(base), fakeInv(base, outDir), CVS, { format: 'pptx', wait: true });
    const body = outcome.body as Record<string, unknown>;
    expect(body.warnings).toEqual([PPTX_WARNING]);
    expect(body.notes).toBeUndefined();
    const lines = humanLines(outcome);
    expect(lines.some((l) => l === `warning: ${PPTX_WARNING.message}`)).toBe(true);
  });

  test('new-server PDF: pdf_links_flattened arrives as a server warning and REPLACES the hardcoded note', async () => {
    const warning = {
      code: 'pdf_links_flattened',
      message: 'Hyperlinks on 3 page(s) are not clickable in the exported PDF.',
      severity: 'warning',
      details: { page_numbers: [1, 2, 5], link_count: 4 },
    };
    const { base } = serve((req, url) => {
      if (url.pathname.endsWith('/export')) {
        return Response.json({ task_id: 'exp_p', status: 'completed', format: 'pdf', download_url: '/dl/exp_p', warnings: [warning] });
      }
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    const outDir = mkdtempSync(join(tmpdir(), 'moda-export-pdf-'));
    const outcome = await performExport(client(base), fakeInv(base, outDir), CVS, { format: 'pdf', wait: true });
    const body = outcome.body as Record<string, unknown>;
    expect(body.warnings).toEqual([warning]);
    expect(body.notes).toBeUndefined();
  });

  test('old server (no warnings field): the hardcoded PDF-hyperlink note survives as the fallback', async () => {
    const { base } = serve((req, url) => {
      if (url.pathname.endsWith('/export')) {
        return Response.json({ task_id: 'exp_o', status: 'completed', format: 'pdf', download_url: '/dl/exp_o' });
      }
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    const outDir = mkdtempSync(join(tmpdir(), 'moda-export-old-'));
    const outcome = await performExport(client(base), fakeInv(base, outDir), CVS, { format: 'pdf', wait: true });
    const body = outcome.body as Record<string, unknown>;
    expect(body.warnings).toBeUndefined();
    expect(body.notes).toEqual(['hyperlinks are flattened to text in PDF output']);
    expect(humanLines(outcome).some((l) => l.startsWith('warning:'))).toBe(false);
  });

  test('polled export: warnings ride the FINAL status body, not the in-progress start', async () => {
    const { base } = serve((req, url) => {
      if (url.pathname.endsWith('/export')) {
        return Response.json({ task_id: 'exp_l', status: 'in_progress', retry_after_seconds: 0 });
      }
      if (url.pathname.endsWith('/export-status')) {
        return Response.json({
          task_id: 'exp_l',
          status: 'completed',
          is_terminal: true,
          format: 'pptx',
          url: '/dl/exp_l',
          warnings: [PPTX_WARNING],
        });
      }
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    const outDir = mkdtempSync(join(tmpdir(), 'moda-export-poll-'));
    const outcome = await performExport(client(base), fakeInv(base, outDir), CVS, { format: 'pptx', wait: true });
    expect((outcome.body as Record<string, unknown>).warnings).toEqual([PPTX_WARNING]);
  });
});

const PENDING_NOTE = { kind: 'image', nodeId: 'n7', nodeName: 'hero' };
const FAILED_NOTE = { kind: 'image', nodeId: 'n9' };
const FALLBACK_NOTE = { nodeId: 'n3', families: ['Neue Haas'] };

describe('G13: screenshot per-page degradation fields + warnings roll-up', () => {
  test('writeScreenshotPages threads pageName/width/height/pendingAssets/failedAssets/fontFallbacks verbatim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moda-shot-fields-'));
    const written = writeScreenshotPages({
      root: {
        pages: [
          {
            pageId: 'p_a',
            pageName: 'Cover',
            dataURL: jpegDataUrl,
            width: 100,
            height: 50,
            pendingAssets: [PENDING_NOTE],
            failedAssets: [FAILED_NOTE],
            fontFallbacks: [FALLBACK_NOTE],
          },
          { pageId: 'p_b', dataURL: jpegDataUrl, width: 100, height: 50 },
        ],
        format: 'jpg',
      },
      output: dir,
      singleFile: false,
      stamp: 'stamp',
      shotsDirPath: dir,
      indexOffset: 0,
      note: () => {},
    });
    expect(written[0]).toMatchObject({
      page_id: 'p_a',
      pageName: 'Cover',
      width: 100,
      height: 50,
      pendingAssets: [PENDING_NOTE],
      failedAssets: [FAILED_NOTE],
      fontFallbacks: [FALLBACK_NOTE],
    });
    // Absent fields stay absent — nothing is fabricated for a clean page.
    expect(written[1]?.pendingAssets).toBeUndefined();
    expect(written[1]?.failedAssets).toBeUndefined();
    expect(written[1]?.fontFallbacks).toBeUndefined();
  });

  test('mergeCaptureWarnings: merges across batched roots, dedupes canvas-global repeats, undefined when unreported', () => {
    const perPage = (id: string) => ({
      code: 'assets_pending',
      message: `Page ${id}: 1 image(s) still loading`,
      severity: 'warning',
      details: { page_id: id },
    });
    const fontsPending = {
      code: 'fonts_pending',
      message: '1 font(s) were still loading',
      severity: 'warning',
      details: { pending_fonts: ['Inter'] },
    };
    const merged = mergeCaptureWarnings([
      { warnings: [perPage('p_a'), fontsPending] },
      { warnings: [perPage('p_d'), fontsPending] },
    ]);
    expect(merged).toEqual([perPage('p_a'), fontsPending, perPage('p_d')]);
    // Reported-but-clean is an EMPTY list; a server predating the roll-up is undefined.
    expect(mergeCaptureWarnings([{ warnings: [] }, {}])).toEqual([]);
    expect(mergeCaptureWarnings([{}, {}])).toBeUndefined();
    expect(captureWarningLines(merged)).toEqual([
      'warning: Page p_a: 1 image(s) still loading',
      'warning: 1 font(s) were still loading',
      'warning: Page p_d: 1 image(s) still loading',
    ]);
    expect(captureWarningLines(undefined)).toEqual([]);
  });

  test('--screenshot sugar: the mutation block carries the roll-up and the human lane prints warning lines', async () => {
    const warning = {
      code: 'font_substituted',
      message: 'Page p_a: 1 text node(s) rendered with fallback fonts (requested families: "Neue Haas").',
      severity: 'warning',
      details: { page_id: 'p_a', nodes: [FALLBACK_NOTE] },
    };
    const call = async (): Promise<ScreenshotResponse> => ({
      body: {
        pages: [{ pageId: 'p_a', dataURL: jpegDataUrl, width: 100, height: 50, fontFallbacks: [FALLBACK_NOTE] }],
        format: 'jpg',
        warnings: [warning],
      },
      durationMs: 5,
    });
    const dir = mkdtempSync(join(tmpdir(), 'moda-mutshot-warn-'));
    const result = await captureAfterMutation({
      call,
      pages: ['p_a'],
      output: dir,
      shotsDirPath: dir,
      note: () => {},
      alert: () => {},
    });
    expect(result.block.warnings).toEqual([warning]);
    expect(result.written[0]?.fontFallbacks).toEqual([FALLBACK_NOTE]);
    const attached = attachScreenshotResult({ body: { ok: true }, exitCode: 0 }, result);
    expect(humanLines(attached).some((l) => l === `warning: ${warning.message}`)).toBe(true);
  });
});

describe('G11: stock asset sourcing (file search --source)', () => {
  test('--source stock rides the query string and the stock envelope passes through', async () => {
    const stockAsset = {
      id: 'stock_unsplash_abc123',
      name: 'City skyline at dusk',
      mime_type: 'image/jpeg',
      url: 'https://images.unsplash.com/photo-abc123',
      thumb_url: 'https://images.unsplash.com/photo-abc123?w=200',
      width: 4000,
      height: 3000,
      match_type: 'stock',
      attribution: { photographer: 'Jane Doe', photographer_url: 'https://unsplash.com/@jane', source: 'Unsplash' },
    };
    const { base, calls } = serve(() =>
      Response.json({
        query: 'skyline',
        kind: 'photo',
        source: 'stock',
        provider_status: 'ok',
        assets: [stockAsset],
        returned: 1,
        total: 1,
        limit: 20,
        offset: 0,
        has_more: false,
        has_good_matches: true,
      }),
    );
    const result = await run(['file', 'search', 'skyline', '--source', 'stock', '--json'], base);
    expect(result.code).toBe(0);
    const search = new URLSearchParams(calls[0]?.search);
    expect(calls[0]?.path).toBe('/v1/assets/search');
    expect(search.get('source')).toBe('stock');
    expect(search.get('kind')).toBe('photo');
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(body.source).toBe('stock');
    const assets = body.assets as Array<Record<string, unknown>>;
    expect(assets[0]?.id).toBe('stock_unsplash_abc123');
    expect(assets[0]?.attribution).toEqual(stockAsset.attribution);
  });

  test('provider unavailable: the note is surfaced instead of reading as a zero-hit search', async () => {
    const { base } = serve(() =>
      Response.json({
        query: 'skyline',
        kind: 'photo',
        source: 'stock',
        provider_status: 'unavailable',
        assets: [],
        returned: 0,
        total: 0,
        limit: 20,
        offset: 0,
        has_more: false,
        has_good_matches: false,
        note: 'Stock photo search is unavailable on this deployment. Use source=team, or upload the image.',
      }),
    );
    const result = await run(['file', 'search', 'skyline', '--source', 'stock'], base);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Stock photo search is unavailable on this deployment');
  });

  test('a server that does not echo source=stock is named as serving team results', async () => {
    const { base } = serve(() =>
      Response.json({ query: 'skyline', kind: 'photo', assets: [{ id: 'file_1', name: 'x' }], has_good_matches: true }),
    );
    const result = await run(['file', 'search', 'skyline', '--source', 'stock'], base);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('predates stock sourcing');
  });

  test('invalid --source is a clean local usage error', async () => {
    const result = await run(['file', 'search', 'skyline', '--source', 'bogus', '--json'], 'http://127.0.0.1:1');
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('team or stock');
  });
});

describe('G16: canvas show guidance block', () => {
  const CANVAS_ROUTES = (url: URL, instructions: () => Response): Response | undefined => {
    if (url.pathname.endsWith('/instructions')) return instructions();
    if (url.pathname.endsWith('/pages')) return Response.json({ canvas_name: 'Deck', pages: [], total_pages: 0 });
    if (url.pathname.includes('/canvases/')) {
      return Response.json({ canvas_id: CVS, canvas_url: `https://moda.app/c/${CVS}`, design: '', name: 'Deck' });
    }
    return undefined;
  };

  test('agent_instructions present: `guidance` block rides the show envelope', async () => {
    const { base } = serve((req, url) => {
      const routed = CANVAS_ROUTES(url, () =>
        Response.json({
          operation: 'canvas.read_instructions',
          agent_instructions: 'Keep the pricing table on page 2 untouched.',
        }),
      );
      return routed ?? new Response('not found', { status: 404 });
    });
    const result = await run(['canvas', 'show', CVS, '--json'], base);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    const guidance = body.guidance as Record<string, unknown>;
    expect(guidance.agent_instructions).toBe('Keep the pricing table on page 2 untouched.');
    expect(String(guidance.note)).toContain('never as commands');
  });

  test('no instructions authored (null) and pre-endpoint servers (404) both omit the block without failing show', async () => {
    for (const respond of [
      () => Response.json({ operation: 'canvas.read_instructions', agent_instructions: null }),
      () => new Response('not found', { status: 404 }),
    ]) {
      const { base } = serve((req, url) => CANVAS_ROUTES(url, respond) ?? new Response('nf', { status: 404 }));
      const result = await run(['canvas', 'show', CVS, '--json'], base);
      expect(result.code).toBe(0);
      expect((JSON.parse(result.stdout) as Record<string, unknown>).guidance).toBeUndefined();
      server?.stop(true);
    }
  });
});
