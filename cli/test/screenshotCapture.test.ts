import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_SCREENSHOT_PAGES_PER_CALL,
  captureScreenshots,
  writeScreenshotPages,
  writtenPageLine,
  type ScreenshotResponse,
} from '../src/commands/screenshotCapture.ts';
import { CliError } from '../src/cliError.ts';
import { EXIT_INVALID_INPUT, EXIT_OK, exitCodeForError } from '../src/output/exitCodes.ts';

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function jpegDataUrl(): string {
  return `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`;
}

function pngDataUrl(): string {
  return `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
}

/** A fake server honoring the live contract: clamp to 3, clamp_note, camelCase pageId echo. */
function clampingServer(options: { echoIds?: boolean } = {}) {
  const calls: Record<string, unknown>[] = [];
  const call = async (body: Record<string, unknown>): Promise<ScreenshotResponse> => {
    calls.push(body);
    const requested = Array.isArray(body.page_ids) ? (body.page_ids as string[]) : ['p_default'];
    const kept = requested.slice(0, MAX_SCREENSHOT_PAGES_PER_CALL);
    const clamped = requested.length > MAX_SCREENSHOT_PAGES_PER_CALL;
    return {
      body: {
        pages: kept.map((id) => ({
          ...(options.echoIds === false ? {} : { pageId: id }),
          dataURL: jpegDataUrl(),
          width: 100,
          height: 100,
        })),
        format: 'jpg',
        ...(clamped
          ? {
              clamp_note: `Requested ${requested.length} pages; captured the first ${MAX_SCREENSHOT_PAGES_PER_CALL}. Call again for the rest.`,
            }
          : {}),
      },
      requestId: `req_${calls.length}`,
      durationMs: 10,
    };
  };
  return { call, calls };
}

describe('captureScreenshots', () => {
  test('at or under the cap: one call, no truncation, no notes', async () => {
    const server = clampingServer();
    const notes: string[] = [];
    const run = await captureScreenshots({
      call: server.call,
      pages: ['p_a', 'p_b', 'p_c'],
      note: (m) => notes.push(m),
    });
    expect(server.calls).toHaveLength(1);
    expect(run.calls).toBe(1);
    expect(run.truncated).toBe(false);
    expect(run.clampNote).toBeUndefined();
    expect(notes).toHaveLength(0);
  });

  test('no --page: one call with no page_ids in the body', async () => {
    const server = clampingServer();
    const run = await captureScreenshots({ call: server.call, note: () => {} });
    expect(server.calls).toEqual([{}]);
    expect(run.truncated).toBe(false);
  });

  test('over the cap: clamp_note surfaced on stderr, remainder auto-batched, all pages captured', async () => {
    const server = clampingServer();
    const notes: string[] = [];
    const pages = ['p_1', 'p_2', 'p_3', 'p_4', 'p_5', 'p_6', 'p_7'];
    const run = await captureScreenshots({ call: server.call, pages, note: (m) => notes.push(m) });
    // 7 pages → full request (clamped to 3) + batches of 3 and 1.
    expect(server.calls).toHaveLength(3);
    expect(server.calls[0]?.page_ids).toEqual(pages);
    expect(server.calls[1]?.page_ids).toEqual(['p_4', 'p_5', 'p_6']);
    expect(server.calls[2]?.page_ids).toEqual(['p_7']);
    expect(run.calls).toBe(3);
    expect(run.truncated).toBe(true);
    expect(run.clampNote).toContain('captured the first 3');
    // Loudness: the server clamp_note verbatim plus the auto-batch notice, both on the note sink.
    expect(notes.some((n) => n.includes('Requested 7 pages'))).toBe(true);
    expect(notes.some((n) => n.includes('auto-batching the remaining 4 page(s) in 2 more call(s)'))).toBe(true);
    // Every requested page came back across the batched roots.
    const captured = run.roots.flatMap((root) =>
      (root.pages as Array<{ pageId: string }>).map((p) => p.pageId),
    );
    expect(captured).toEqual(pages);
    expect(run.durationMs).toBe(30);
    expect(run.requestId).toBe('req_1');
  });

  test('over the cap without echoed page ids: positional fallback still fetches the remainder', async () => {
    const server = clampingServer({ echoIds: false });
    const pages = ['p_1', 'p_2', 'p_3', 'p_4', 'p_5'];
    const run = await captureScreenshots({ call: server.call, pages, note: () => {} });
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]?.page_ids).toEqual(['p_4', 'p_5']);
    expect(run.truncated).toBe(true);
  });

  test('a server that does not clamp needs no batching and is not marked truncated', async () => {
    const calls: Record<string, unknown>[] = [];
    const generous = async (body: Record<string, unknown>): Promise<ScreenshotResponse> => {
      calls.push(body);
      const requested = body.page_ids as string[];
      return {
        body: { pages: requested.map((id) => ({ pageId: id, dataURL: jpegDataUrl() })), format: 'jpg' },
        durationMs: 5,
      };
    };
    const run = await captureScreenshots({ call: generous, pages: ['p_1', 'p_2', 'p_3', 'p_4'], note: () => {} });
    expect(calls).toHaveLength(1);
    expect(run.truncated).toBe(false);
  });
});

describe('writeScreenshotPages (batching path shares the single-call mime/naming logic)', () => {
  test('each batched root names files by its own declared format; page ids come from camelCase pageId', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moda-shots-'));
    const rootA = { pages: [{ pageId: 'p_a', dataURL: jpegDataUrl() }], format: 'jpg' };
    const rootB = { pages: [{ pageId: 'p_b', dataURL: pngDataUrl() }], format: 'png' };
    const shared = { output: dir, singleFile: false, stamp: 's', shotsDirPath: '/unused', note: () => {} };
    const writtenA = writeScreenshotPages({ root: rootA, indexOffset: 0, ...shared });
    const writtenB = writeScreenshotPages({ root: rootB, indexOffset: writtenA.length, ...shared });
    expect(writtenA).toEqual([{ page_id: 'p_a', path: join(dir, 'p_a.jpg') }]);
    expect(writtenB).toEqual([{ page_id: 'p_b', path: join(dir, 'p_b.png') }]);
    expect(readFileSync(writtenA[0]!.path)).toEqual(JPEG_BYTES);
    expect(readFileSync(writtenB[0]!.path)).toEqual(PNG_BYTES);
  });

  test('indexOffset keeps fallback numbering unique across batches when ids are missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moda-shots-'));
    const shared = { output: dir, singleFile: false, stamp: 's', shotsDirPath: '/unused', note: () => {} };
    const first = writeScreenshotPages({
      root: { pages: [{ dataURL: jpegDataUrl() }, { dataURL: jpegDataUrl() }], format: 'jpg' },
      indexOffset: 0,
      ...shared,
    });
    const second = writeScreenshotPages({
      root: { pages: [{ dataURL: jpegDataUrl() }], format: 'jpg' },
      indexOffset: first.length,
      ...shared,
    });
    expect(first.map((p) => p.path)).toEqual([join(dir, 'page-1.jpg'), join(dir, 'page-2.jpg')]);
    expect(second.map((p) => p.path)).toEqual([join(dir, 'page-3.jpg')]);
  });

  test('explicit -o single-file path is honored only when the whole invocation is one page', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moda-shots-'));
    const out = join(dir, 'cover.jpg');
    const written = writeScreenshotPages({
      root: { pages: [{ pageId: 'p_a', dataURL: jpegDataUrl() }], format: 'jpg' },
      output: out,
      singleFile: true,
      stamp: 's',
      shotsDirPath: '/unused',
      indexOffset: 0,
      note: () => {},
    });
    expect(written).toEqual([{ page_id: 'p_a', path: out }]);
    expect(existsSync(out)).toBe(true);
  });

  test('default shots-dir naming uses one stamp per invocation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moda-shots-'));
    const written = writeScreenshotPages({
      root: { pages: [{ pageId: 'p_z', dataURL: jpegDataUrl() }], format: 'jpg' },
      singleFile: false,
      stamp: '2026-08-10T00-00-00-000Z',
      shotsDirPath: dir,
      indexOffset: 0,
      note: () => {},
    });
    expect(written[0]?.path).toBe(join(dir, '2026-08-10T00-00-00-000Z-p_z.jpg'));
  });
});

describe('writtenPageLine (defect D2: no "? →" placeholder)', () => {
  test('with a page id: "id → path"; without: just the path', () => {
    expect(writtenPageLine({ page_id: 'p_a', path: '/x/p_a.jpg' })).toBe('p_a → /x/p_a.jpg');
    expect(writtenPageLine({ path: '/x/page-1.jpg' })).toBe('/x/page-1.jpg');
    expect(writtenPageLine({ path: '/x/page-1.jpg' })).not.toContain('?');
  });
});

describe('in-band capture refusal (ENG-4982: success:false must not read as success)', () => {
  /** The live shape: HTTP 200, `success: false`, typed error block, no `pages`. */
  const refusal = {
    success: false,
    error: {
      code: 'INVALID_PAGE',
      message: 'Target page "1" was not found in the current document — no screenshots were captured.',
      details: {
        failedPageIds: [{ pageId: '1', errorCode: 'INVALID_PAGE' }],
        availablePageIds: ['page-111', 'page-222'],
      },
    },
  };

  test('throws a typed error instead of returning an empty run', async () => {
    const call = async (): Promise<ScreenshotResponse> => ({ body: refusal, durationMs: 1 });
    const err = (await captureScreenshots({ call, note: () => {} }).catch((e: unknown) => e)) as CliError;
    expect(err).toBeInstanceOf(CliError);
    // Server code rides through lowercased; exit class is did-not-commit, never 0.
    expect(err.fields.code).toBe('invalid_page');
    expect(err.fields.type).toBe('unprocessable');
    expect(exitCodeForError(err.fields)).toBe(EXIT_INVALID_INPUT);
    expect(exitCodeForError(err.fields)).not.toBe(EXIT_OK);
  });

  test('surfaces the available page ids — the only place they are printed', async () => {
    const call = async (): Promise<ScreenshotResponse> => ({ body: refusal, durationMs: 1 });
    const err = (await captureScreenshots({ call, note: () => {} }).catch((e: unknown) => e)) as CliError;
    expect(err.fields.hint).toContain('page-111');
    expect(err.fields.hint).toContain('page-222');
  });

  test('a refusal on a BATCHED follow-up call fails the run too', async () => {
    let n = 0;
    const call = async (body: Record<string, unknown>): Promise<ScreenshotResponse> => {
      n += 1;
      if (n === 1) {
        const kept = (body.page_ids as string[]).slice(0, MAX_SCREENSHOT_PAGES_PER_CALL);
        return {
          body: { pages: kept.map((id) => ({ pageId: id, dataURL: jpegDataUrl() })), format: 'jpg' },
          durationMs: 1,
        };
      }
      return { body: refusal, durationMs: 1 };
    };
    const pages = ['p1', 'p2', 'p3', 'p4'];
    expect(captureScreenshots({ call, pages, note: () => {} })).rejects.toBeInstanceOf(CliError);
  });

  test('a successful run is untouched (no success field, or success: true)', async () => {
    for (const extra of [{}, { success: true }]) {
      const call = async (): Promise<ScreenshotResponse> => ({
        body: { ...extra, pages: [{ pageId: 'p_a', dataURL: jpegDataUrl() }], format: 'jpg' },
        durationMs: 1,
      });
      const run = await captureScreenshots({ call, note: () => {} });
      expect(run.roots).toHaveLength(1);
    }
  });
});
