/**
 * `--screenshot <path>` capture sugar on the mutation verbs (`canvas markup` / `canvas edit` /
 * `canvas add-pages`).
 *
 * After the mutation COMMITS, the CLI immediately runs the standalone screenshot capture for
 * the touched page(s) and writes the file(s) — one invocation instead of mutate-then-screenshot.
 * Pure client-side composition of existing verbs: the capture rides the exact
 * `moda canvas screenshot` path (screenshotCapture.ts — auto-batching, clamp loudness, naming);
 * there are no server changes and no new endpoint semantics.
 *
 * Failure containment: by the time the capture runs the mutation has committed, and the §3
 * exit-code contract reserves nonzero for "nothing committed" — so a capture failure NEVER
 * changes the exit code. It is surfaced loudly on stderr and as `screenshot.ok: false` in the
 * --json document; the recovery is the standalone `moda canvas screenshot`.
 */
import { asObject, str } from '../api/types.ts';
import { CliError } from '../cliError.ts';
import type { CommandOutcome } from '../output/emit.ts';
import {
  captureScreenshots,
  writeCaptureRun,
  writtenPageLine,
  type ScreenshotCall,
  type WrittenPage,
} from './screenshotCapture.ts';

/**
 * Pages a `canvas markup` apply touches: its `--page` target. `canvas` (floating nodes) has no
 * single page — fall back to the default capture, exactly like `canvas screenshot` without
 * `--page`.
 */
export function pagesForMarkupTarget(page: string): string[] | undefined {
  return page === 'canvas' ? undefined : [page];
}

/**
 * Created-page ids reported by an add-pages mutation response. Tolerant of the live tool-host
 * camelCase shape (`createdPages[].pageId`) and snake_case contract drift (D2); undefined when
 * the response reports none — the capture then falls back to the default capture.
 */
export function pagesFromMutationResponse(body: unknown): string[] | undefined {
  const root = asObject(body);
  for (const key of ['created_page_ids', 'page_ids']) {
    const flat = root[key];
    if (Array.isArray(flat)) {
      const ids = flat.filter((v): v is string => typeof v === 'string');
      if (ids.length > 0) return ids;
    }
  }
  for (const key of ['createdPages', 'created_pages', 'pages']) {
    const entries = root[key];
    if (Array.isArray(entries)) {
      const ids: string[] = [];
      for (const entry of entries) {
        const page = asObject(entry);
        const id = str(page, 'pageId') ?? str(page, 'page_id') ?? str(page, 'id');
        if (id !== undefined) ids.push(id);
      }
      if (ids.length > 0) return ids;
    }
  }
  return undefined;
}

export interface MutationScreenshotResult {
  /** The `screenshot` block of the mutation's --json document. */
  block: Record<string, unknown>;
  written: WrittenPage[];
}

/** Run the post-mutation capture and write the files. Never throws — the mutation committed. */
export async function captureAfterMutation(input: {
  call: ScreenshotCall;
  /** Touched page ids; undefined = the default capture (same as `canvas screenshot` without --page). */
  pages?: string[];
  /** `--screenshot` value: output file (single captured page) or directory — `-o` semantics. */
  output: string;
  shotsDirPath: string;
  note: (message: string) => void;
}): Promise<MutationScreenshotResult> {
  try {
    const capture = await captureScreenshots({ call: input.call, pages: input.pages, note: input.note });
    const written = writeCaptureRun({
      capture,
      output: input.output,
      shotsDirPath: input.shotsDirPath,
      note: input.note,
    });
    return {
      block: {
        ok: true,
        ...(capture.truncated ? { truncated: true } : {}),
        ...(capture.calls > 1 ? { capture_calls: capture.calls } : {}),
        pages: written,
      },
      written,
    };
  } catch (err) {
    const message = err instanceof CliError ? err.fields.message : err instanceof Error ? err.message : String(err);
    input.note(`⚠ mutation committed, but the --screenshot capture failed: ${message} — re-run: moda canvas screenshot`);
    return { block: { ok: false, error: message }, written: [] };
  }
}

/** Attach the capture to a mutation outcome: `screenshot` in --json, written-page lines in human output. */
export function attachScreenshotResult(outcome: CommandOutcome, result: MutationScreenshotResult): CommandOutcome {
  const baseHuman = outcome.human;
  return {
    ...outcome,
    body: { ...outcome.body, screenshot: result.block },
    human: (write) => {
      baseHuman?.(write);
      for (const page of result.written) write(writtenPageLine(page));
    },
  };
}
