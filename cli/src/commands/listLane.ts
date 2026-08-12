/**
 * The uniform list lane: `--limit`/`--offset` passthrough, `total`/`has_more` surfacing,
 * `--all` bounded auto-pagination, and `--output` big-pull routing — tolerant of BOTH server
 * generations. New servers return the uniform `{returned, total | has_more, limit, offset}`
 * shape (the websites-list contract, rolling out to every /v1 list lane); old servers return a
 * bare page. The rule either way: a list result is a PAGE, not the universe — never present
 * one as everything.
 */
import type { ApiClient } from '../api/client.ts';
import { asObject, num, str, type JsonObject } from '../api/types.ts';
import { CliError } from '../cliError.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import type { CommandOutcome } from '../output/emit.ts';
import { PREVIEW_ITEMS, writeResultFile } from '../output/resultFile.ts';
import { metaBlock } from './runtime.ts';

/** Hard client cap for --all: auto-pagination must never melt a huge workspace into context. */
export const LIST_ALL_CAP = 500;

/** Array field names the /v1 list lanes return their items under. */
const LIST_ITEM_KEYS = [
  'items', 'data', 'canvases', 'results', 'tasks', 'files', 'brand_kits', 'websites', 'assets',
  'models', 'image_models', 'organizations', 'pages', 'folders',
];

/**
 * Server pagination style (#9317): CURSOR lanes (brand-kits, canvases list, organizations,
 * tasks) page by `next_cursor` and IGNORE offset — sending one silently re-serves page 1.
 * OFFSET lanes (websites, canvases/search, assets/search) take limit/offset.
 */
export type PaginationMode = 'cursor' | 'offset';

export interface ListFlags {
  limit?: number;
  offset?: number;
  all?: boolean;
  output?: string;
  /** Cursor lanes: resume token from a previous page's next_cursor. */
  cursor?: string;
}

/** Commander parser for --limit (1..500) shared across list verbs. */
export function parseListLimit(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value.trim()) || parsed < 1 || parsed > LIST_ALL_CAP) {
    throw CliError.usage(`Invalid --limit value '${value}' — expected an integer between 1 and ${LIST_ALL_CAP}.`);
  }
  return parsed;
}

/** Commander parser for --offset (>= 0) shared across list verbs. */
export function parseListOffset(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value.trim()) || parsed < 0) {
    throw CliError.usage(`Invalid --offset value '${value}' — expected a non-negative integer.`);
  }
  return parsed;
}

export interface ListPages {
  /** First-page root with the item field replaced by the merged items. */
  root: JsonObject;
  itemKey?: string;
  items: JsonObject[];
  returned: number;
  total?: number;
  hasMore?: boolean;
  /** --all stopped at LIST_ALL_CAP. */
  capped: boolean;
  /** The server reported neither total, has_more, nor next_cursor — a bare page (pre-#9317). */
  oldServer: boolean;
  startOffset: number;
  pagesFetched: number;
  mode: PaginationMode;
  /** Cursor lanes: the resume token for the page after the last one fetched. */
  nextCursor?: string;
  requestId?: string;
  durationMs: number;
}

function extractItems(body: unknown): { itemKey?: string; items: JsonObject[] } {
  if (Array.isArray(body)) return { items: body.map(asObject) };
  const root = asObject(body);
  for (const key of LIST_ITEM_KEYS) {
    if (Array.isArray(root[key])) return { itemKey: key, items: (root[key] as unknown[]).map(asObject) };
  }
  return { items: [] };
}

/**
 * Fetch one page — or, under --all, pages until complete/capped. Offset lanes advance by item
 * count; cursor lanes follow `next_cursor` (offset is refused there: the server ignores it and
 * would silently re-serve page 1). Old-server tolerance: with no total, has_more, or
 * next_cursor the loop cannot verify progress, so --all stops after the first page rather
 * than risking a duplicate-page loop; the page note says so.
 */
export async function fetchListPages(
  client: ApiClient,
  path: string,
  baseQuery: Record<string, string | undefined>,
  flags: ListFlags,
  timeoutMs?: number,
  mode: PaginationMode = 'offset',
): Promise<ListPages> {
  if (mode === 'cursor' && flags.offset !== undefined) {
    throw CliError.usage(
      'This lane paginates by cursor, not offset — the server would ignore --offset and re-serve page 1.',
      "Use --all, or resume from a previous page's next_cursor with --cursor <token>.",
    );
  }
  const startOffset = flags.offset ?? 0;
  let offset = startOffset;
  let cursor = flags.cursor;
  const merged: JsonObject[] = [];
  let firstRoot: JsonObject = {};
  let itemKey: string | undefined;
  let total: number | undefined;
  let hasMore: boolean | undefined;
  let nextCursor: string | undefined;
  let oldServer = false;
  let capped = false;
  let pagesFetched = 0;
  let requestId: string | undefined;
  let durationMs = 0;

  for (;;) {
    const response = await client.request({
      method: 'GET',
      path,
      query: {
        ...baseQuery,
        ...(flags.limit !== undefined ? { limit: String(flags.limit) } : {}),
        ...(mode === 'cursor'
          ? { ...(cursor !== undefined ? { cursor } : {}) }
          : { ...(offset !== startOffset || flags.offset !== undefined ? { offset: String(offset) } : {}) }),
      },
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    pagesFetched += 1;
    requestId = response.requestId ?? requestId;
    durationMs += response.durationMs;
    const root = asObject(response.body);
    const page = extractItems(response.body);
    // total: null (CursorPage lanes) and ABSENT (canvases/search) are the same "no total" —
    // num() maps both to undefined.
    const pageCursor = str(root, 'next_cursor');
    if (pagesFetched === 1) {
      firstRoot = Array.isArray(response.body) ? {} : root;
      itemKey = page.itemKey;
      total = num(root, 'total');
      hasMore = typeof root.has_more === 'boolean' ? root.has_more : undefined;
      oldServer = total === undefined && hasMore === undefined && pageCursor === undefined;
    } else {
      // Later pages refresh the moving-window signals.
      total = num(root, 'total') ?? total;
      hasMore = typeof root.has_more === 'boolean' ? root.has_more : hasMore;
    }
    nextCursor = pageCursor;
    merged.push(...page.items);
    if (flags.all !== true) break;
    if (oldServer) break; // cannot verify pagination progress — never risk a duplicate loop
    if (page.items.length === 0) break;
    if (mode === 'cursor') {
      if (nextCursor === undefined || hasMore === false) break;
      cursor = nextCursor;
    } else {
      offset += page.items.length;
      if (hasMore === false) break;
      if (total !== undefined && offset >= total) break;
    }
    if (merged.length >= LIST_ALL_CAP) {
      capped = true;
      break;
    }
  }

  const root: JsonObject = { ...firstRoot };
  if (itemKey !== undefined) root[itemKey] = merged;
  return {
    root,
    itemKey,
    items: merged,
    returned: merged.length,
    total,
    hasMore,
    capped,
    oldServer,
    startOffset,
    pagesFetched,
    mode,
    nextCursor,
    requestId,
    durationMs,
  };
}

/** The lane-correct continuation instruction. */
function continueWith(pages: ListPages): string {
  if (pages.mode === 'cursor') {
    return pages.nextCursor !== undefined ? `--cursor ${pages.nextCursor}, or --all` : '--all';
  }
  return `--offset ${pages.startOffset + pages.returned}, or --all`;
}

/** The one honest page line — appended to every list verb's human output. */
export function pageNote(pages: ListPages): string {
  if (pages.capped) {
    return `stopped at ${pages.returned} items (client cap ${LIST_ALL_CAP}) — narrow the query, or continue with ${continueWith(pages)}`;
  }
  if (pages.oldServer) {
    return `showing ${pages.returned} (server did not report a total — there may be more; newer servers do)`;
  }
  if (pages.total !== undefined) {
    const shownThrough = pages.startOffset + pages.returned;
    if (shownThrough >= pages.total && pages.hasMore !== true) {
      return pages.startOffset > 0
        ? `showing ${pages.returned} of ${pages.total} (from offset ${pages.startOffset})`
        : `showing all ${pages.total}`;
    }
    return (
      `showing ${pages.returned} of ${pages.total}` +
      `${pages.startOffset > 0 ? ` (from offset ${pages.startOffset})` : ''} — more via ${continueWith(pages)}`
    );
  }
  return pages.hasMore === true
    ? `showing ${pages.returned} — more available (${continueWith(pages)})`
    : `showing ${pages.returned}${pages.hasMore === false && pages.mode === 'cursor' ? ' (all)' : ''}`;
}

/** Machine fields for the envelope (documented list-lane surface). */
export function pageFields(pages: ListPages, flags: ListFlags): Record<string, unknown> {
  return {
    returned: pages.returned,
    ...(pages.total !== undefined ? { total: pages.total } : {}),
    ...(pages.hasMore !== undefined ? { has_more: pages.hasMore } : {}),
    ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
    ...(pages.mode === 'offset' && pages.startOffset > 0 ? { offset: pages.startOffset } : {}),
    ...(pages.nextCursor !== undefined ? { next_cursor: pages.nextCursor } : {}),
    ...(pages.capped ? { capped: true } : {}),
    ...(pages.pagesFetched > 1 ? { pages_fetched: pages.pagesFetched } : {}),
  };
}

/**
 * Build the standard list outcome: items (or --output file routing with a bounded preview),
 * page fields, per-item human lines, the empty hint, and the page note.
 */
export function listOutcome(opts: {
  operation: string;
  pages: ListPages;
  flags: ListFlags;
  emptyHint?: string;
  itemLine: (item: JsonObject) => string;
}): CommandOutcome {
  const { operation, pages, flags } = opts;
  const note = pageNote(pages);
  if (flags.output !== undefined) {
    const written = writeResultFile(flags.output, {
      ok: true,
      operation,
      ...pages.root,
      ...(pages.itemKey === undefined ? { items: pages.items } : {}),
      ...pageFields(pages, flags),
    });
    const preview = pages.items.slice(0, PREVIEW_ITEMS).map(opts.itemLine);
    return {
      body: {
        ok: true,
        operation,
        ...pageFields(pages, flags),
        ...written,
        preview,
        meta: metaBlock({ requestId: pages.requestId, durationMs: pages.durationMs }),
      },
      human: (write) => {
        write(`${pages.returned} item${pages.returned === 1 ? '' : 's'} → ${written.output} (inspect with jq/grep)`);
        for (const line of preview) write(line);
        write(note);
      },
      exitCode: EXIT_OK,
    };
  }
  return {
    body: {
      ok: true,
      operation,
      ...pages.root,
      ...(pages.itemKey === undefined && pages.items.length > 0 ? { items: pages.items } : {}),
      ...pageFields(pages, flags),
      meta: { ...asObject(pages.root.meta), ...metaBlock({ requestId: pages.requestId, durationMs: pages.durationMs }) },
    },
    human: (write) => {
      if (pages.items.length === 0 && opts.emptyHint !== undefined) {
        write(opts.emptyHint);
        return;
      }
      for (const item of pages.items) write(opts.itemLine(item));
      write(note);
    },
    exitCode: EXIT_OK,
  };
}

/** Shared option wiring: `--limit`, `--offset`, `--all`, `--output` on a list verb. */
export function listFlagsOf(opts: Record<string, unknown>): ListFlags {
  return {
    limit: typeof opts.limit === 'number' ? opts.limit : undefined,
    offset: typeof opts.offset === 'number' ? opts.offset : undefined,
    all: opts.all === true,
    output: typeof opts.output === 'string' ? opts.output : undefined,
    cursor: typeof opts.cursor === 'string' ? opts.cursor : undefined,
  };
}
