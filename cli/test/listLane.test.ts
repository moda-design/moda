/**
 * The uniform list lane: --limit/--offset passthrough, total/has_more surfacing, --all bounded
 * auto-pagination (500-item client cap), old-server bare-page tolerance, --output interplay.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient } from '../src/api/client.ts';
import { asObject, str } from '../src/api/types.ts';
import { LIST_ALL_CAP, fetchListPages, listOutcome, pageFields, pageNote } from '../src/commands/listLane.ts';
import { CliError } from '../src/cliError.ts';

let server: ReturnType<typeof Bun.serve> | undefined;

function serve(handler: (url: URL, hits: number) => Response): { base: string; urls: URL[] } {
  const urls: URL[] = [];
  let hits = 0;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => {
      hits += 1;
      const url = new URL(req.url);
      urls.push(url);
      return handler(url, hits);
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, urls };
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
    env: { MODA_STATE_DIR: '/tmp/moda-listlane-test' },
  });
}

function canvases(from: number, count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({ id: `cvs_${from + i}`, name: `Canvas ${from + i}` }));
}

function humanLines(outcome: { human?: (write: (line: string) => void) => void }): string[] {
  const lines: string[] = [];
  outcome.human?.((line) => lines.push(line));
  return lines;
}

describe('fetchListPages', () => {
  test('single page: limit/offset pass through; total/has_more surfaced', async () => {
    const { base, urls } = serve(() =>
      Response.json({ canvases: canvases(20, 5), total: 47, has_more: true, limit: 5, offset: 20 }),
    );
    const pages = await fetchListPages(client(base), '/v1/canvases', {}, { limit: 5, offset: 20 });
    expect(urls[0]?.searchParams.get('limit')).toBe('5');
    expect(urls[0]?.searchParams.get('offset')).toBe('20');
    expect(pages.returned).toBe(5);
    expect(pages.total).toBe(47);
    expect(pages.hasMore).toBe(true);
    expect(pages.oldServer).toBe(false);
    expect(pageNote(pages)).toBe('showing 5 of 47 (from offset 20) — more via --offset 25, or --all');
  });

  test('--all paginates to completion and merges', async () => {
    const { base, urls } = serve((url) => {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      return Response.json({ canvases: canvases(offset, Math.min(2, 5 - offset)), total: 5 });
    });
    const pages = await fetchListPages(client(base), '/v1/canvases', {}, { limit: 2, all: true });
    expect(pages.returned).toBe(5);
    expect(pages.pagesFetched).toBe(3);
    expect(urls.map((u) => u.searchParams.get('offset'))).toEqual([null, '2', '4']);
    expect(pages.items.map((i) => i.id)).toEqual(['cvs_0', 'cvs_1', 'cvs_2', 'cvs_3', 'cvs_4', 'cvs_5'].slice(0, 5));
    expect(pageNote(pages)).toBe('showing all 5');
  });

  test('--all stops LOUDLY at the client cap', async () => {
    const { base } = serve((url) => {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      return Response.json({ canvases: canvases(offset, 100), total: 10_000, has_more: true });
    });
    const pages = await fetchListPages(client(base), '/v1/canvases', {}, { all: true });
    expect(pages.capped).toBe(true);
    expect(pages.returned).toBeGreaterThanOrEqual(LIST_ALL_CAP);
    expect(pages.returned).toBeLessThan(LIST_ALL_CAP + 101);
    expect(pageNote(pages)).toContain(`client cap ${LIST_ALL_CAP}`);
    expect(pageNote(pages)).toContain('--offset');
  });

  test('old server (bare page): --all never risks a duplicate loop; wording is honest', async () => {
    const { base, urls } = serve(() => Response.json({ canvases: canvases(0, 20) }));
    const pages = await fetchListPages(client(base), '/v1/canvases', {}, { all: true });
    expect(urls.length).toBe(1);
    expect(pages.oldServer).toBe(true);
    expect(pageNote(pages)).toBe('showing 20 (server did not report a total — there may be more; newer servers do)');
  });

  test('bare-array bodies (models-style) work with items key synthesis', async () => {
    const { base } = serve(() => Response.json([{ id: 'model_a' }, { id: 'model_b' }]));
    const pages = await fetchListPages(client(base), '/v1/media/models', {}, {});
    expect(pages.returned).toBe(2);
    expect(pages.itemKey).toBeUndefined();
    expect(pages.oldServer).toBe(true);
  });
});


describe('#9317 shipped envelopes (cursor/offset lane split)', () => {
  test('FOUNDER REPRO: brand list --all walks 25 kits across two cursor pages (data key, total null)', async () => {
    const kits = Array.from({ length: 25 }, (_, i) => ({ id: `bk_${i}`, name: `Kit ${i}` }));
    const { base, urls } = serve((url) => {
      const cursor = url.searchParams.get('cursor');
      if (cursor === null) {
        return Response.json({
          data: kits.slice(0, 13), next_cursor: 'c_page2', returned: 13, has_more: true, limit: 25, total: null,
        });
      }
      return Response.json({ data: kits.slice(13), next_cursor: null, returned: 12, has_more: false, limit: 25, total: null });
    });
    const pages = await fetchListPages(client(base), '/v1/brand-kits', {}, { all: true }, undefined, 'cursor');
    expect(pages.returned).toBe(25);
    expect(pages.pagesFetched).toBe(2);
    expect(urls[1]?.searchParams.get('cursor')).toBe('c_page2');
    expect(urls[1]?.searchParams.get('offset')).toBeNull();
    expect(pages.itemKey).toBe('data');
    expect(pages.items[24]?.id).toBe('bk_24');
    // total: null is treated as no-total; has_more false closes the walk honestly.
    expect(pages.total).toBeUndefined();
    expect(pageNote(pages)).toBe('showing 25 (all)');
  });

  test('cursor lanes REFUSE --offset with the lane-truth usage error', async () => {
    const { base } = serve(() => Response.json({ data: [], next_cursor: null, has_more: false }));
    try {
      await fetchListPages(client(base), '/v1/brand-kits', {}, { offset: 25 }, undefined, 'cursor');
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.code).toBe('usage');
      expect((err as CliError).fields.message).toContain('re-serve page 1');
      expect((err as CliError).fields.hint).toContain('--cursor');
    }
  });

  test('single cursor page surfaces next_cursor + the resume wording', async () => {
    const { base } = serve(() =>
      Response.json({ data: [{ id: 'bk_0' }], next_cursor: 'c_next', returned: 1, has_more: true, limit: 1, total: null }),
    );
    const flags = { limit: 1 };
    const pages = await fetchListPages(client(base), '/v1/brand-kits', {}, flags, undefined, 'cursor');
    expect(pageFields(pages, flags).next_cursor).toBe('c_next');
    expect(pageFields(pages, flags).offset).toBeUndefined();
    expect(pageNote(pages)).toBe('showing 1 — more available (--cursor c_next, or --all)');
  });

  test('canvases/search shipped shape: has_more only, total ABSENT — wording handles the missing key', async () => {
    const { base } = serve(() =>
      Response.json({ canvases: [{ id: 'cvs_a' }, { id: 'cvs_b' }], returned: 2, limit: 2, offset: 0, has_more: true }),
    );
    const pages = await fetchListPages(client(base), '/v1/canvases/search', { q: 'x' }, { limit: 2 });
    expect(pages.total).toBeUndefined();
    expect(pages.oldServer).toBe(false);
    expect(pageNote(pages)).toBe('showing 2 — more available (--offset 2, or --all)');
  });

  test('cursor --all resumes FROM a seed --cursor', async () => {
    const { base, urls } = serve((url) => {
      const cursor = url.searchParams.get('cursor');
      if (cursor === 'c_seed') {
        return Response.json({ data: [{ id: 'bk_5' }], next_cursor: 'c_6', returned: 1, has_more: true, total: null });
      }
      return Response.json({ data: [{ id: 'bk_6' }], next_cursor: null, returned: 1, has_more: false, total: null });
    });
    const pages = await fetchListPages(client(base), '/v1/brand-kits', {}, { all: true, cursor: 'c_seed' }, undefined, 'cursor');
    expect(urls[0]?.searchParams.get('cursor')).toBe('c_seed');
    expect(pages.returned).toBe(2);
  });
});

describe('listOutcome', () => {
  const itemLine = (item: Record<string, unknown>) => `${str(asObject(item), 'id') ?? '?'}`;

  test('envelope carries page fields; human = items then the page note', async () => {
    const { base } = serve(() => Response.json({ canvases: canvases(0, 2), total: 9 }));
    const flags = { limit: 2 };
    const pages = await fetchListPages(client(base), '/v1/canvases', {}, flags);
    const outcome = listOutcome({ operation: 'canvas.list', pages, flags, itemLine });
    const body = outcome.body as Record<string, unknown>;
    expect(body.returned).toBe(2);
    expect(body.total).toBe(9);
    expect(body.limit).toBe(2);
    const lines = humanLines(outcome);
    expect(lines).toEqual(['cvs_0', 'cvs_1', 'showing 2 of 9 — more via --offset 2, or --all']);
  });

  test('--output interplay: merged pull lands in the file; envelope keeps a bounded preview', async () => {
    const { base } = serve((url) => {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      return Response.json({ canvases: canvases(offset, Math.min(4, 10 - offset)), total: 10 });
    });
    const out = join(mkdtempSync(join(tmpdir(), 'moda-listout-')), 'canvases.json');
    const flags = { all: true, output: out, limit: 4 };
    const pages = await fetchListPages(client(base), '/v1/canvases', {}, flags);
    const outcome = listOutcome({ operation: 'canvas.list', pages, flags, itemLine });
    const body = outcome.body as Record<string, unknown>;
    expect(body.returned).toBe(10);
    expect(body.canvases).toBeUndefined();
    expect((body.preview as unknown[]).length).toBe(3);
    const onDisk = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    expect((onDisk.canvases as unknown[]).length).toBe(10);
    expect(onDisk.returned).toBe(10);
    const lines = humanLines(outcome);
    expect(lines[0]).toContain(`10 items → ${out}`);
    expect(lines.at(-1)).toBe('showing all 10');
  });

  test('empty page renders the steering hint', async () => {
    const { base } = serve(() => Response.json({ canvases: [], total: 0 }));
    const pages = await fetchListPages(client(base), '/v1/canvases', {}, {});
    const outcome = listOutcome({ operation: 'canvas.list', pages, flags: {}, emptyHint: 'no canvases', itemLine });
    expect(humanLines(outcome)).toEqual(['no canvases']);
  });
});
