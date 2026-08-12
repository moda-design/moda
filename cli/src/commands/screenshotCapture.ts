/**
 * Screenshot capture orchestration. The server caps captures at
 * MAX_SCREENSHOT_PAGES_PER_CALL pages per call: extra requested pages are clamped (first N kept)
 * and reported via `clamp_note`, never rejected. The CLI keeps the single-call contract loud —
 * the first call carries the FULL request so the server's `clamp_note` comes back (surfaced on
 * stderr, `truncated: true` in --json) — and then auto-batches additional calls for the clamped
 * remainder so the whole request is fulfilled in one invocation.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { asObject, str } from '../api/types.ts';
import { detectImageFormat, resolveScreenshotPath } from './screenshotFiles.ts';

/** Server ceiling (backend MAX_SCREENSHOT_PAGES): base64 payload size, not a request validator. */
export const MAX_SCREENSHOT_PAGES_PER_CALL = 3;

export interface ScreenshotResponse {
  body: unknown;
  requestId?: string;
  durationMs: number;
}

/** One POST to the screenshot endpoint; the command supplies the authed transport. */
export type ScreenshotCall = (body: Record<string, unknown>) => Promise<ScreenshotResponse>;

export interface CaptureRun {
  /** Response roots in call order; the first is the original full request's response. */
  roots: Record<string, unknown>[];
  /** True when the server clamped the single-call request (clamp_note or fewer pages than asked). */
  truncated: boolean;
  /** The server's clamp_note from the first response, verbatim. */
  clampNote?: string;
  requestId?: string;
  /** Wall time summed across every batched call. */
  durationMs: number;
  calls: number;
}

function requestBody(pages: string[] | undefined, pixelRatio: number | undefined): Record<string, unknown> {
  return {
    ...(pages !== undefined ? { page_ids: pages } : {}),
    ...(pixelRatio !== undefined ? { pixel_ratio: pixelRatio } : {}),
  };
}

function pageEntries(root: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(root.pages) ? root.pages.map((p) => asObject(p)) : [];
}

/** Page ids echoed by a capture response (tool-host camelCase `pageId` is the live shape). */
function capturedPageIds(root: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const page of pageEntries(root)) {
    const id = str(page, 'page_id') ?? str(page, 'pageId') ?? str(page, 'id');
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/**
 * Run the capture, auto-batching past the server's per-call page cap.
 *
 * The first call sends every requested page id; when the server clamps it (cap = 3/call), the
 * clamp_note is surfaced through `note` (stderr) and the un-captured remainder is fetched in
 * follow-up calls of at most MAX_SCREENSHOT_PAGES_PER_CALL ids each. `truncated` records that the
 * single-call contract clamped — the aggregated `roots` still carry every requested page.
 */
export async function captureScreenshots(input: {
  call: ScreenshotCall;
  pages?: string[];
  pixelRatio?: number;
  /** stderr notice sink (Invocation.note). */
  note: (message: string) => void;
}): Promise<CaptureRun> {
  const { call, pages, pixelRatio } = input;
  const first = await call(requestBody(pages, pixelRatio));
  const roots = [asObject(first.body)];
  let durationMs = first.durationMs;
  const clampNote = str(roots[0]!, 'clamp_note');
  let truncated = clampNote !== undefined;
  if (clampNote !== undefined) input.note(`⚠ ${clampNote}`);

  if (pages !== undefined && pages.length > MAX_SCREENSHOT_PAGES_PER_CALL) {
    // The server keeps the FIRST cap-many ids. Prefer the echoed page ids to compute the
    // remainder; fall back to positional slicing when the response does not echo ids.
    const firstEntries = pageEntries(roots[0]!);
    const echoedIds = capturedPageIds(roots[0]!);
    const remaining =
      echoedIds.length === firstEntries.length && firstEntries.length > 0
        ? pages.filter((id) => !new Set(echoedIds).has(id))
        : pages.slice(firstEntries.length);
    if (remaining.length > 0) {
      truncated = true;
      const batches = Math.ceil(remaining.length / MAX_SCREENSHOT_PAGES_PER_CALL);
      input.note(
        `server captures at most ${MAX_SCREENSHOT_PAGES_PER_CALL} pages per call — auto-batching the remaining ` +
          `${remaining.length} page(s) in ${batches} more call(s)`,
      );
      for (let i = 0; i < remaining.length; i += MAX_SCREENSHOT_PAGES_PER_CALL) {
        const response = await call(requestBody(remaining.slice(i, i + MAX_SCREENSHOT_PAGES_PER_CALL), pixelRatio));
        durationMs += response.durationMs;
        const root = asObject(response.body);
        // Defensive: a follow-up chunk is ≤ the cap, but surface any clamp the server reports.
        const followUpClamp = str(root, 'clamp_note');
        if (followUpClamp !== undefined) input.note(`⚠ ${followUpClamp}`);
        roots.push(root);
      }
    }
  }
  return { roots, truncated, clampNote, requestId: first.requestId, durationMs, calls: roots.length };
}

export interface WrittenPage {
  page_id?: string;
  path: string;
  /** Server per-page fields, threaded VERBATIM (tool-host-owned wire shapes — never reshaped). */
  pageName?: string;
  width?: number;
  height?: number;
  /** Assets still loading when the frame was grabbed — a THIS-CAPTURE timing artifact. */
  pendingAssets?: unknown[];
  /** Image fills that drew the load-failure placeholder — usually transient (never regenerate). */
  failedAssets?: unknown[];
  /** Text nodes that rendered with substitute fonts (the typography is not the design's). */
  fontFallbacks?: unknown[];
}

/**
 * The per-page degradation/context fields the server reports alongside `dataURL`, copied
 * verbatim onto the written page so the CLI envelope keeps the truth the transport carried
 * (reading-and-verifying.md documents these to agents). Absent fields stay absent.
 */
function passthroughPageFields(page: Record<string, unknown>): Partial<WrittenPage> {
  const pageName = str(page, 'pageName');
  return {
    ...(pageName !== undefined ? { pageName } : {}),
    ...(typeof page.width === 'number' ? { width: page.width } : {}),
    ...(typeof page.height === 'number' ? { height: page.height } : {}),
    ...(Array.isArray(page.pendingAssets) ? { pendingAssets: page.pendingAssets } : {}),
    ...(Array.isArray(page.failedAssets) ? { failedAssets: page.failedAssets } : {}),
    ...(Array.isArray(page.fontFallbacks) ? { fontFallbacks: page.fontFallbacks } : {}),
  };
}

/**
 * The typed `warnings[]` roll-up merged across every batched call, deduped by serialized
 * identity — canvas-global entries (`fonts_pending`) repeat verbatim on each batched response
 * and must not multiply, while per-page entries are naturally distinct. Returns `undefined`
 * when NO response carried the field (a server predating the roll-up), so callers can tell
 * "nothing degraded" from "not reported".
 */
export function mergeCaptureWarnings(roots: Record<string, unknown>[]): Record<string, unknown>[] | undefined {
  let reported = false;
  const seen = new Set<string>();
  const merged: Record<string, unknown>[] = [];
  for (const root of roots) {
    if (!Array.isArray(root.warnings)) continue;
    reported = true;
    for (const warning of root.warnings) {
      const entry = asObject(warning);
      const key = JSON.stringify(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }
  return reported ? merged : undefined;
}

/** Human `warning: …` lines for the merged roll-up (site.ts style; message verbatim). */
export function captureWarningLines(warnings: Record<string, unknown>[] | undefined): string[] {
  return (warnings ?? []).map(
    (warning) => `warning: ${str(warning, 'message') ?? str(warning, 'code') ?? JSON.stringify(warning)}`,
  );
}

/**
 * Decode and write every page of a capture run (all batched roots) with the single-call
 * naming/mime logic — the shared writer behind `canvas screenshot` and the mutation verbs'
 * `--screenshot` flag.
 */
export function writeCaptureRun(input: {
  capture: CaptureRun;
  /** `-o` / `--screenshot` value: output file (whole run yields one page) or directory. */
  output?: string;
  /** Default shots directory for this canvas (used when no output path is given). */
  shotsDirPath: string;
  note: (message: string) => void;
}): WrittenPage[] {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const totalPages = input.capture.roots.reduce((n, root) => n + (Array.isArray(root.pages) ? root.pages.length : 0), 0);
  let written: WrittenPage[] = [];
  for (const root of input.capture.roots) {
    written = written.concat(
      writeScreenshotPages({
        root,
        output: input.output,
        singleFile: totalPages === 1,
        stamp,
        shotsDirPath: input.shotsDirPath,
        indexOffset: written.length,
        note: input.note,
      }),
    );
  }
  return written;
}

/**
 * Decode and write one capture response's pages to disk. Naming and format detection are
 * per-response — each batched call's root carries its own declared `format` — so the batching
 * path reuses the exact single-call mime/naming logic (screenshotFiles.ts).
 */
export function writeScreenshotPages(input: {
  root: Record<string, unknown>;
  /** -o value: single file (whole invocation yields exactly one page) or directory. */
  output?: string;
  /** True when the WHOLE invocation (all batches) yields exactly one page. */
  singleFile: boolean;
  /** One timestamp per invocation so batched calls land in one coherent series. */
  stamp: string;
  /** Default shots directory for this canvas (used when -o is absent). */
  shotsDirPath: string;
  /** Pages already written by earlier batches (keeps fallback numbering globally unique). */
  indexOffset: number;
  note: (message: string) => void;
}): WrittenPage[] {
  const { root, output } = input;
  const written: WrittenPage[] = [];
  pageEntries(root).forEach((page, index) => {
    const dataUrl = str(page, 'dataURL') ?? str(page, 'data_url');
    if (dataUrl === undefined) return;
    // Live tool-host shape is camelCase `pageId`; snake_case kept for contract drift (D2).
    const pageId = str(page, 'page_id') ?? str(page, 'pageId') ?? str(page, 'id');
    const comma = dataUrl.indexOf(',');
    const bytes = Buffer.from(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl, 'base64');
    const dataUrlMime = comma >= 0 ? /^data:([^;,]+)/.exec(dataUrl)?.[1] : undefined;
    const format = detectImageFormat({
      bytes,
      declaredFormat: str(page, 'format') ?? str(root, 'format'),
      dataUrlMime,
    });
    const globalIndex = input.indexOffset + index;
    const named = resolveScreenshotPath({
      format,
      explicitPath: output !== undefined && input.singleFile ? output : undefined,
      stem:
        output !== undefined
          ? join(output, pageId ?? `page-${globalIndex + 1}`)
          : join(input.shotsDirPath, `${input.stamp}-${pageId ?? globalIndex + 1}`),
    });
    if (named.warning !== undefined) input.note(named.warning);
    mkdirSync(dirname(named.path), { recursive: true });
    writeFileSync(named.path, bytes);
    written.push({ page_id: pageId, path: named.path, ...passthroughPageFields(page) });
  });
  return written;
}

/** Human output line for one written page — just the path when the server omitted the id (D2: no '? →'). */
export function writtenPageLine(page: WrittenPage): string {
  return page.page_id !== undefined ? `${page.page_id} → ${page.path}` : page.path;
}
