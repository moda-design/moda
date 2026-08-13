/** Shared canvas-verb plumbing: ref resolution (incl. share URLs), revision cache, mutation shaping. */
import { readFileSync } from 'node:fs';
import { ApiClient } from '../api/client.ts';
import { endpoints } from '../api/endpoints.ts';
import { asObject, str } from '../api/types.ts';
import { CliError } from '../cliError.ts';
import { readRevisionEntry, updateRevisionOnly, writeRevisionEntry } from '../config/state.ts';
import { extractShortIds, parseRef } from '../refs.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import type { CommandOutcome } from '../output/emit.ts';
import { metaBlock, type Invocation } from './runtime.ts';

/**
 * Normalize an import-pages `--source` value. The server field takes a cvs_ id, a UUID, or a
 * bare share TOKEN — anything else falls down its share-token path and 404s with a misleading
 * share-link message. Pasted URLs therefore resolve client-side through the same refs.ts
 * machinery as positional CANVAS_REF args (#23): a canvas URL yields its id, a /s/ share URL
 * yields its bare token. Non-URL inputs pass through untouched (a bare share token is not
 * parseable as a ref, so `parseRef` must only see URLs here).
 */
export function normalizeImportSource(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return trimmed;
  const parsed = parseRef(trimmed, 'canvas');
  return parsed.shareToken ?? parsed.ref;
}

/** Resolve a CANVAS_REF argument to the wire ref, resolving share URLs server-side first. */
export async function resolveCanvasRef(input: string, client: ApiClient): Promise<string> {
  const parsed = parseRef(input, 'canvas');
  if (parsed.shareToken === undefined) return parsed.ref;
  // Server contract: ResolveShareLinkRequest {url} — accepts a share URL or a bare token.
  const response = await client.request({
    method: 'POST',
    path: endpoints.shareLinkResolve(),
    body: { url: parsed.shareToken },
    timeoutMs: 30_000,
  });
  const root = asObject(response.body);
  const canvas = asObject(root.canvas);
  const resolved = str(canvas, 'id') ?? str(root, 'canvas_id') ?? str(root, 'id');
  if (resolved === undefined) {
    throw new CliError({
      type: 'not_found',
      code: 'share_unresolved',
      message: 'Share link did not resolve to a canvas.',
      source: 'api',
    });
  }
  return resolved;
}

/** `--file page.xml` or `--file -` (stdin) — the agent-ergonomic path. */
export async function readFileArg(fileArg: string): Promise<string> {
  if (fileArg === '-') return await Bun.stdin.text();
  try {
    return readFileSync(fileArg, 'utf8');
  } catch (err) {
    throw CliError.io(`Cannot read ${fileArg}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface RevisionChoice {
  expectedRevision?: string;
  source: 'flag' | 'cache' | 'none';
}

/**
 * Pick the expected revision: explicit --revision > the CLI's cached last read. Verbs where the
 * contract REQUIRES a revision (edit, delete-items, markup --mode replace) fail loudly with the
 * read instruction when neither exists.
 */
export function chooseRevision(
  ref: string,
  flagRevision: string | undefined,
  required: boolean,
  env: NodeJS.ProcessEnv,
): RevisionChoice {
  if (flagRevision !== undefined) return { expectedRevision: flagRevision, source: 'flag' };
  const cached = readRevisionEntry(ref, env);
  if (cached !== undefined) return { expectedRevision: cached.revision, source: 'cache' };
  if (required) {
    throw CliError.usage(
      'This mutation requires a revision token and none is cached for this canvas.',
      `Run \`moda canvas read ${ref}\` first (or pass --revision).`,
    );
  }
  return { source: 'none' };
}

/** stderr staleness sugar: warn when submitted short ids are absent from the last read. */
export function warnStaleShortIds(ref: string, submitted: string[], inv: Invocation): void {
  if (submitted.length === 0) return;
  const cached = readRevisionEntry(ref, inv.env);
  if (cached === undefined || cached.short_ids.length === 0) return;
  const known = new Set(cached.short_ids);
  const missing = submitted.filter((id) => !known.has(id));
  if (missing.length > 0) {
    inv.note(`id ${missing.join(', ')} not in last read — run: moda canvas read ${ref}`);
  }
}

/**
 * Cache the revision (and short-id set when DSL text is available) from a READ-lane response
 * (canvas read/state, lint). Mutation responses must NEVER feed this cache: their `revision`
 * is advisory only — trailing CRDT chunks of the same write can land after the response, so
 * the only pinnable tokens come from reads (rulings §15). Mutation handlers may display the
 * advisory token but must not call this.
 */
export function cacheFromResponse(ref: string, body: unknown, env: NodeJS.ProcessEnv, dslText?: string): void {
  const root = asObject(body);
  const revision = str(root, 'revision');
  if (revision === undefined) return;
  const keys = new Set<string>();
  if (ref.length > 0) keys.add(ref);
  const canvas = asObject(root.canvas);
  for (const k of [str(canvas, 'id'), str(canvas, 'uuid')]) if (k !== undefined) keys.add(k);
  for (const key of keys) {
    if (dslText !== undefined) {
      writeRevisionEntry(key, { revision, short_ids: extractShortIds(dslText), read_at: new Date().toISOString() }, env);
    } else {
      updateRevisionOnly(key, revision, env);
    }
  }
}

/**
 * Shape a mutation response into the §3 output contract document. Never caches the advisory
 * revision. Idempotent replays (`replayed: true`, and `reused_existing: true` + the original
 * `created_at` + a steering `note` on a replayed create) are surfaced LOUDLY in human output;
 * the --json document carries the server fields verbatim via the spread.
 */
export function mutationOutcome(
  operation: string,
  _ref: string,
  _inv: Invocation,
  response: { body: unknown; requestId?: string; durationMs: number },
): CommandOutcome {
  const root = asObject(response.body);
  const body: Record<string, unknown> = {
    ok: true,
    operation,
    ...root,
    meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
  };
  const requiresRepair = root.requires_repair === true;
  const counts = asObject(root.operation_counts);
  const replayed = root.replayed === true;
  return {
    body,
    human: (write) => {
      if (root.reused_existing === true) {
        const createdAt = str(root, 'created_at');
        write(
          `⚠ REUSED existing canvas${createdAt !== undefined ? ` (created ${createdAt})` : ''} — server replayed ` +
            'your idempotency key; use a new name/key for a fresh canvas',
        );
      } else if (replayed) {
        write(
          '⚠ REPLAYED — the server returned the stored result of an earlier identical call ' +
            '(idempotency key match); nothing was applied again',
        );
      }
      const serverNote = str(root, 'note');
      if (serverNote !== undefined) write(`server note: ${serverNote}`);
      const revision = str(root, 'revision');
      write(
        `${operation}: ${replayed ? 'replayed (stored result — not re-applied)' : 'committed'}` +
          `${revision !== undefined ? ` (advisory revision ${revision} — pin only from reads)` : ''}` +
          (typeof counts.applied === 'number' ? ` — applied ${counts.applied}/${counts.queued ?? '?'}` : '') +
          (typeof counts.skipped === 'number' && counts.skipped > 0 ? `, skipped ${counts.skipped}` : ''),
      );
      if (requiresRepair) {
        write('requires_repair: true — read the warnings and author a corrective edit (do not re-run).');
        const warnings = Array.isArray(root.warnings) ? root.warnings : [];
        for (const warning of warnings) {
          const w = asObject(warning);
          write(`  [${str(w, 'severity') ?? 'warn'}] ${str(w, 'code') ?? ''}: ${str(w, 'message') ?? ''}`);
        }
      }
      const editorUrl = str(root, 'editor_url');
      if (editorUrl !== undefined) write(`editor: ${editorUrl}`);
    },
    exitCode: EXIT_OK,
  };
}

/** Wrap a read/list response as the standard output document. */
/** Array field names the list/search lanes return their items under. */
const LIST_ITEM_KEYS = ['items', 'canvases', 'results', 'tasks', 'files', 'brand_kits', 'websites'];

export function passthroughOutcome(
  operation: string,
  response: { body: unknown; requestId?: string; durationMs: number },
  _inv: Invocation,
  /** List-lane sugar: adds `returned: n` and, on zero results, the steering line in human output. */
  listLane?: { emptyHint: string },
): CommandOutcome {
  const root = asObject(response.body);
  const items = Array.isArray(response.body)
    ? (response.body as unknown[])
    : LIST_ITEM_KEYS.map((key) => root[key]).find(Array.isArray);
  return {
    body: {
      ok: true,
      operation,
      ...(Array.isArray(response.body) ? { items: response.body } : root),
      ...(listLane !== undefined && Array.isArray(items) ? { returned: items.length } : {}),
      meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
    },
    ...(listLane !== undefined && Array.isArray(items) && items.length === 0
      ? { human: (write: (line: string) => void) => write(listLane.emptyHint) }
      : {}),
    exitCode: EXIT_OK,
  };
}

/** Parse `--size WxH`. */
export function parseSize(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!match) throw CliError.usage(`Invalid --size '${value}' — expected WxH, e.g. 1920x1080.`);
  return { width: Number.parseInt(match[1] as string, 10), height: Number.parseInt(match[2] as string, 10) };
}
