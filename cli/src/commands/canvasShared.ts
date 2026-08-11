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

/** Resolve a CANVAS_REF argument to the wire ref, resolving share URLs server-side first. */
export async function resolveCanvasRef(input: string, client: ApiClient): Promise<string> {
  const parsed = parseRef(input, 'canvas');
  if (parsed.shareToken === undefined) return parsed.ref;
  const response = await client.request({
    method: 'POST',
    path: endpoints.shareLinkResolve(),
    body: { token: parsed.shareToken },
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

/** Cache the revision (and short-id set when DSL text is available) after reads and mutations. */
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

/** Shape a mutation response into the §3 output contract document. */
export function mutationOutcome(
  operation: string,
  ref: string,
  inv: Invocation,
  response: { body: unknown; requestId?: string; durationMs: number },
): CommandOutcome {
  const root = asObject(response.body);
  cacheFromResponse(ref, root, inv.env);
  const body: Record<string, unknown> = {
    ok: true,
    operation,
    ...root,
    meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
  };
  const requiresRepair = root.requires_repair === true;
  const counts = asObject(root.operation_counts);
  return {
    body,
    human: (write) => {
      const revision = str(root, 'revision');
      write(
        `${operation}: committed${revision !== undefined ? ` (revision ${revision})` : ''}` +
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
export function passthroughOutcome(
  operation: string,
  response: { body: unknown; requestId?: string; durationMs: number },
  _inv: Invocation,
): CommandOutcome {
  const root = asObject(response.body);
  return {
    body: {
      ok: true,
      operation,
      ...(Array.isArray(response.body) ? { items: response.body } : root),
      meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
    },
    exitCode: EXIT_OK,
  };
}

/** Parse `--size WxH`. */
export function parseSize(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!match) throw CliError.usage(`Invalid --size '${value}' — expected WxH, e.g. 1920x1080.`);
  return { width: Number.parseInt(match[1] as string, 10), height: Number.parseInt(match[2] as string, 10) };
}
