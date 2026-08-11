import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachScreenshotResult,
  captureAfterMutation,
  pagesForMarkupTarget,
  pagesFromMutationResponse,
} from '../src/commands/mutationScreenshot.ts';
import { MAX_SCREENSHOT_PAGES_PER_CALL, type ScreenshotResponse } from '../src/commands/screenshotCapture.ts';
import { EXIT_OK } from '../src/output/exitCodes.ts';

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function jpegDataUrl(): string {
  return `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`;
}

/** A fake server honoring the live contract: clamp to 3, clamp_note, camelCase pageId echo. */
function clampingServer() {
  const calls: Record<string, unknown>[] = [];
  const call = async (body: Record<string, unknown>): Promise<ScreenshotResponse> => {
    calls.push(body);
    const requested = Array.isArray(body.page_ids) ? (body.page_ids as string[]) : ['p_default'];
    const kept = requested.slice(0, MAX_SCREENSHOT_PAGES_PER_CALL);
    const clamped = requested.length > MAX_SCREENSHOT_PAGES_PER_CALL;
    return {
      body: {
        pages: kept.map((id) => ({ pageId: id, dataURL: jpegDataUrl(), width: 100, height: 100 })),
        format: 'jpg',
        ...(clamped
          ? { clamp_note: `Requested ${requested.length} pages; captured the first ${MAX_SCREENSHOT_PAGES_PER_CALL}.` }
          : {}),
      },
      durationMs: 10,
    };
  };
  return { call, calls };
}

describe('pagesForMarkupTarget', () => {
  test('a real page id captures just that page', () => {
    expect(pagesForMarkupTarget('p_a')).toEqual(['p_a']);
  });

  test("the floating-node target 'canvas' has no single page — default capture", () => {
    expect(pagesForMarkupTarget('canvas')).toBeUndefined();
  });
});

describe('pagesFromMutationResponse (add-pages touched-page extraction)', () => {
  test('live tool-host camelCase shape: createdPages[].pageId', () => {
    expect(
      pagesFromMutationResponse({ createdPages: [{ pageId: 'p_x', pageIndex: 1 }, { pageId: 'p_y', pageIndex: 2 }] }),
    ).toEqual(['p_x', 'p_y']);
  });

  test('snake_case drift shapes: created_pages[].page_id and flat id arrays', () => {
    expect(pagesFromMutationResponse({ created_pages: [{ page_id: 'p_x' }] })).toEqual(['p_x']);
    expect(pagesFromMutationResponse({ created_page_ids: ['p_x', 'p_y'] })).toEqual(['p_x', 'p_y']);
    expect(pagesFromMutationResponse({ page_ids: ['p_z'] })).toEqual(['p_z']);
  });

  test('flat arrays win over entry arrays, and non-strings are filtered', () => {
    expect(pagesFromMutationResponse({ page_ids: ['p_a', 7], createdPages: [{ pageId: 'p_b' }] })).toEqual(['p_a']);
  });

  test('no page information → undefined (default capture)', () => {
    expect(pagesFromMutationResponse({})).toBeUndefined();
    expect(pagesFromMutationResponse({ page_ids: [] })).toBeUndefined();
    expect(pagesFromMutationResponse(undefined)).toBeUndefined();
  });
});

describe('captureAfterMutation', () => {
  test('single touched page to an explicit file path (`-o` semantics)', async () => {
    const server = clampingServer();
    const dir = mkdtempSync(join(tmpdir(), 'moda-mutshot-'));
    const out = join(dir, 'preview.jpg');
    const result = await captureAfterMutation({
      call: server.call,
      pages: ['p_a'],
      output: out,
      shotsDirPath: '/unused',
      note: () => {},
    });
    expect(server.calls).toEqual([{ page_ids: ['p_a'] }]);
    expect(result.block.ok).toBe(true);
    expect(result.written).toEqual([{ page_id: 'p_a', path: out }]);
    expect(result.block.pages).toEqual(result.written);
    expect(result.block.truncated).toBeUndefined();
    expect(result.block.capture_calls).toBeUndefined();
    expect(existsSync(out)).toBe(true);
  });

  test('many touched pages to a directory reuses the auto-batching past the server cap', async () => {
    const server = clampingServer();
    const dir = mkdtempSync(join(tmpdir(), 'moda-mutshot-'));
    const notes: string[] = [];
    const result = await captureAfterMutation({
      call: server.call,
      pages: ['p_1', 'p_2', 'p_3', 'p_4'],
      output: dir,
      shotsDirPath: '/unused',
      note: (m) => notes.push(m),
    });
    expect(server.calls).toHaveLength(2);
    expect(result.block.ok).toBe(true);
    expect(result.block.truncated).toBe(true);
    expect(result.block.capture_calls).toBe(2);
    expect(result.written.map((p) => p.path)).toEqual(['p_1', 'p_2', 'p_3', 'p_4'].map((id) => join(dir, `${id}.jpg`)));
    expect(notes.some((n) => n.includes('auto-batching'))).toBe(true);
  });

  test('no touched-page info: default capture with no page_ids in the body', async () => {
    const server = clampingServer();
    const dir = mkdtempSync(join(tmpdir(), 'moda-mutshot-'));
    const out = join(dir, 'default-capture');
    const result = await captureAfterMutation({
      call: server.call,
      output: out,
      shotsDirPath: '/unused',
      note: () => {},
    });
    expect(server.calls).toEqual([{}]);
    // One captured page → `-o` single-file semantics; extensionless paths gain the byte format.
    expect(result.written).toEqual([{ page_id: 'p_default', path: `${out}.jpg` }]);
  });

  test('a capture failure never throws: ok:false block + loud stderr note, no files', async () => {
    const notes: string[] = [];
    const result = await captureAfterMutation({
      call: async () => {
        throw new Error('render_failed: renderer busy');
      },
      pages: ['p_a'],
      output: '/unused/out.jpg',
      shotsDirPath: '/unused',
      note: (m) => notes.push(m),
    });
    expect(result.block).toEqual({ ok: false, error: 'render_failed: renderer busy' });
    expect(result.written).toEqual([]);
    expect(notes.some((n) => n.includes('mutation committed, but the --screenshot capture failed'))).toBe(true);
    expect(notes.some((n) => n.includes('re-run: moda canvas screenshot'))).toBe(true);
  });
});

describe('attachScreenshotResult', () => {
  test('adds the screenshot block to the --json document and page lines after the base human output', () => {
    const outcome = {
      body: { ok: true, operation: 'canvas.edit' },
      human: (write: (line: string) => void) => write('canvas.edit: committed'),
      exitCode: EXIT_OK,
    };
    const attached = attachScreenshotResult(outcome, {
      block: { ok: true, pages: [{ page_id: 'p_a', path: '/x/p_a.jpg' }] },
      written: [{ page_id: 'p_a', path: '/x/p_a.jpg' }],
    });
    expect(attached.exitCode).toBe(EXIT_OK);
    expect(attached.body.screenshot).toEqual({ ok: true, pages: [{ page_id: 'p_a', path: '/x/p_a.jpg' }] });
    expect(attached.body.operation).toBe('canvas.edit');
    const lines: string[] = [];
    attached.human?.((line) => lines.push(line));
    expect(lines).toEqual(['canvas.edit: committed', 'p_a → /x/p_a.jpg']);
  });

  test('a failed capture attaches its error block and appends no page lines', () => {
    const attached = attachScreenshotResult(
      { body: { ok: true, operation: 'canvas.create_from_markup' }, exitCode: EXIT_OK },
      { block: { ok: false, error: 'boom' }, written: [] },
    );
    expect(attached.body.screenshot).toEqual({ ok: false, error: 'boom' });
    const lines: string[] = [];
    attached.human?.((line) => lines.push(line));
    expect(lines).toEqual([]);
  });
});
