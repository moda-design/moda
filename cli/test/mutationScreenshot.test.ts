import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachScreenshotResult,
  captureAfterMutation,
  pagesForEditResult,
  pagesForMarkupTarget,
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

describe('pagesForEditResult', () => {
  test('a non-empty changed_page_ids set captures exactly those pages', () => {
    expect(pagesForEditResult({ committed: true, changed_page_ids: ['p_b', 'p_a'] })).toEqual(['p_b', 'p_a']);
  });

  test('an empty set (variable-only edit) falls back to the default capture', () => {
    expect(pagesForEditResult({ committed: true, changed_page_ids: [] })).toBeUndefined();
  });

  test('an absent field (backend predating changed_page_ids) falls back to the default capture', () => {
    expect(pagesForEditResult({ committed: true, page_ids: [] })).toBeUndefined();
  });

  test('non-string entries are dropped, and an all-junk array falls back', () => {
    expect(pagesForEditResult({ changed_page_ids: ['p_a', 7, null] })).toEqual(['p_a']);
    expect(pagesForEditResult({ changed_page_ids: [7, null] })).toBeUndefined();
  });

  test('a multi-page changed set rides the existing auto-batching past the server cap', async () => {
    const server = clampingServer();
    const dir = mkdtempSync(join(tmpdir(), 'moda-mutshot-'));
    const pages = pagesForEditResult({ changed_page_ids: ['p_1', 'p_2', 'p_3', 'p_4', 'p_5'] });
    const result = await captureAfterMutation({
      call: server.call,
      pages,
      output: dir,
      shotsDirPath: '/unused',
      note: () => {},
      alert: () => {},
    });
    expect(server.calls).toHaveLength(2);
    expect(server.calls[0]).toEqual({ page_ids: ['p_1', 'p_2', 'p_3', 'p_4', 'p_5'] });
    expect(result.block.truncated).toBe(true);
    expect(result.written.map((p) => p.page_id)).toEqual(['p_1', 'p_2', 'p_3', 'p_4', 'p_5']);
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
      alert: () => {},
    });
    expect(server.calls).toEqual([{ page_ids: ['p_a'] }]);
    expect(result.block.ok).toBe(true);
    // width/height thread through from the capture response (G13 per-page passthrough).
    expect(result.written).toEqual([{ page_id: 'p_a', path: out, width: 100, height: 100 }]);
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
      alert: () => {},
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
      alert: () => {},
    });
    expect(server.calls).toEqual([{}]);
    // One captured page → `-o` single-file semantics; extensionless paths gain the byte format.
    expect(result.written).toEqual([{ page_id: 'p_default', path: `${out}.jpg`, width: 100, height: 100 }]);
  });

  test('a capture failure never throws: ok:false block + non-suppressible failure line, no files', async () => {
    // Two channels, exactly as wired in canvas.ts: `note` is the --quiet-suppressed progress
    // channel; `alert` is the non-suppressible stderr writer. Under --quiet non-JSON, notes
    // are dropped — the failure line must arrive on `alert` alone or the claim "surfaces on
    // stderr" is false in that mode.
    const notes: string[] = [];
    const alerts: string[] = [];
    const result = await captureAfterMutation({
      call: async () => {
        throw new Error('render_failed: renderer busy');
      },
      pages: ['p_a'],
      output: '/unused/out.jpg',
      shotsDirPath: '/unused',
      note: (m) => notes.push(m),
      alert: (m) => alerts.push(m),
    });
    expect(result.block).toEqual({ ok: false, error: 'render_failed: renderer busy' });
    expect(result.written).toEqual([]);
    expect(alerts.some((n) => n.includes('mutation committed, but the --screenshot capture failed'))).toBe(true);
    expect(alerts.some((n) => n.includes('re-run: moda canvas screenshot'))).toBe(true);
    // The suppressed channel carries no part of the failure — quiet mode still hears it.
    expect(notes.filter((n) => n.includes('capture failed'))).toEqual([]);
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
      { body: { ok: true, operation: 'canvas.markup' }, exitCode: EXIT_OK },
      { block: { ok: false, error: 'boom' }, written: [] },
    );
    expect(attached.body.screenshot).toEqual({ ok: false, error: 'boom' });
    const lines: string[] = [];
    attached.human?.((line) => lines.push(line));
    expect(lines).toEqual([]);
  });
});

describe('in-band capture refusal after a COMMITTED mutation (ENG-4982)', () => {
  const refusal = {
    success: false,
    error: { code: 'INVALID_PAGE', message: 'Target page "1" was not found in the current document.' },
  };

  test('is contained: no throw, screenshot.ok false, alert on stderr', async () => {
    const alerts: string[] = [];
    const call = async (): Promise<ScreenshotResponse> => ({ body: refusal, durationMs: 1 });
    const result = await captureAfterMutation({
      call,
      output: join(mkdtempSync(join(tmpdir(), 'moda-mut-')), 'shot'),
      shotsDirPath: mkdtempSync(join(tmpdir(), 'moda-shots-')),
      note: () => {},
      alert: (m) => alerts.push(m),
    });
    expect(result.block.ok).toBe(false);
    expect(result.written).toHaveLength(0);
    expect(alerts.join('\n')).toContain('mutation committed');
    expect(alerts.join('\n')).toContain('not found');
  });

  test('the mutation still exits 0 — nonzero is reserved for did-not-commit', async () => {
    const call = async (): Promise<ScreenshotResponse> => ({ body: refusal, durationMs: 1 });
    const result = await captureAfterMutation({
      call,
      output: join(mkdtempSync(join(tmpdir(), 'moda-mut-')), 'shot'),
      shotsDirPath: mkdtempSync(join(tmpdir(), 'moda-shots-')),
      note: () => {},
      alert: () => {},
    });
    const outcome = attachScreenshotResult(
      { body: { ok: true, operation: 'canvas.markup' }, exitCode: EXIT_OK },
      result,
    );
    expect(outcome.exitCode).toBe(EXIT_OK);
    expect((outcome.body.screenshot as Record<string, unknown>).ok).toBe(false);
  });
});
