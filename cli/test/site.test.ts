/**
 * `moda site` unit lane: mock HTTP server + the exported perform* helpers, locking the settled
 * website contract — POST/GET /v1/websites, PUT .../content (no auto-republish), POST
 * .../publish (slug_prefix, review_status), POST .../unpublish, DELETE — plus the
 * destructive-verb --yes gate.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ApiClient } from '../src/api/client.ts';
import { CliError } from '../src/cliError.ts';
import {
  parseSiteId,
  performSiteCreate,
  performSiteDelete,
  performSiteList,
  performSitePublish,
  performSiteSetContent,
  performSiteShow,
  performSiteUnpublish,
  requireYes,
} from '../src/commands/site.ts';

const SITE_ID = '3f2b7a10-9c4d-4e8f-b1a2-5d6e7f809012';

let server: ReturnType<typeof Bun.serve> | undefined;

interface Captured {
  method: string;
  path: string;
  search: string;
  body: Record<string, unknown>;
}

function serve(respond: (req: Request) => Response | Promise<Response>): { base: string; calls: Captured[] } {
  const calls: Captured[] = [];
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      calls.push({ method: req.method, path: url.pathname, search: url.search, body });
      return respond(req);
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
    busyBackoffMs: [5, 10, 15],
    sleeper: async () => {},
    env: { MODA_STATE_DIR: '/tmp/moda-site-test-state' },
  });
}

function website(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SITE_ID,
    name: 'Launch Page',
    version: 1,
    is_published: false,
    url: null,
    slug: null,
    has_unpublished_changes: null,
    review_status: null,
    created_at: '2026-08-11T00:00:00Z',
    updated_at: '2026-08-11T00:00:00Z',
    ...overrides,
  };
}

function humanLines(outcome: { human?: (write: (line: string) => void) => void }): string[] {
  const lines: string[] = [];
  outcome.human?.((line) => lines.push(line));
  return lines;
}

describe('parseSiteId', () => {
  test('accepts a plain UUID', () => {
    expect(parseSiteId(` ${SITE_ID} `)).toBe(SITE_ID);
  });

  test('rejects non-UUID refs with a usage error naming site list', () => {
    for (const bad of ['site_abc', 'launch-page', 'https://launch.moda.page', '']) {
      try {
        parseSiteId(bad);
        expect.unreachable();
      } catch (err) {
        expect((err as CliError).fields.code).toBe('usage');
        expect((err as CliError).fields.hint).toContain('moda site list');
      }
    }
  });
});

describe('requireYes (destructive-verb gate, canvas delete parity)', () => {
  test('--json/--no-input without --yes is a usage error whose hint is the exact re-run command', () => {
    try {
      requireYes('Deleting a site', true, false, `moda site delete ${SITE_ID}`);
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.code).toBe('usage');
      expect((err as CliError).fields.message).toContain('--yes');
      expect((err as CliError).fields.hint).toBe(
        `If the host/user approved this action, re-run with --yes: moda site delete ${SITE_ID} --yes`,
      );
    }
  });

  test('--yes passes; interactive mode passes without --yes', () => {
    expect(() => requireYes('Deleting a site', true, true, 'moda site delete x')).not.toThrow();
    expect(() => requireYes('Deleting a site', false, false, 'moda site delete x')).not.toThrow();
  });
});

describe('site create (POST /v1/websites)', () => {
  test('sends {html, title} plus the injected idempotency_key; envelope + publish hint', async () => {
    const { base, calls } = serve(() => Response.json({ operation: 'websites.create', website: website() }));
    const outcome = await performSiteCreate(client(base), { html: '<html><body>hi</body></html>', title: 'Launch Page' });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/v1/websites');
    expect(calls[0]?.body.html).toBe('<html><body>hi</body></html>');
    expect(calls[0]?.body.title).toBe('Launch Page');
    expect(typeof calls[0]?.body.idempotency_key).toBe('string');
    const body = outcome.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.operation).toBe('site.create');
    expect((body.meta as Record<string, unknown>).cli_version).toBeUndefined();
    expect(typeof (body.meta as Record<string, unknown>).duration_ms).toBe('number');
    const lines = humanLines(outcome);
    expect(lines[0]).toContain(SITE_ID);
    expect(lines[1]).toBe(`publish it: moda site publish ${SITE_ID}`);
  });

  test('keyed replay is announced', async () => {
    const { base } = serve(() => Response.json({ operation: 'websites.create', website: website(), replayed: true }));
    const lines = humanLines(await performSiteCreate(client(base), { html: '<html>x</html>' }));
    expect(lines[1]).toBe('(replayed — this site already existed)');
  });

  test('empty HTML is a local usage error — no request', async () => {
    const { base, calls } = serve(() => Response.json({}));
    await expect(performSiteCreate(client(base), { html: '   ' })).rejects.toThrow(CliError);
    expect(calls.length).toBe(0);
  });
});

describe('site list (GET /v1/websites)', () => {
  test('passes limit/offset and renders live + stale states', async () => {
    const { base, calls } = serve(() =>
      Response.json({
        websites: [
          website({ is_published: true, url: 'https://launch-x1.moda.page', slug: 'launch-x1', has_unpublished_changes: true }),
        ],
        total: 7,
        limit: 2,
        offset: 4,
      }),
    );
    const outcome = await performSiteList(client(base), { limit: 2, offset: 4 });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.search).toBe('?limit=2&offset=4');
    const lines = humanLines(outcome);
    expect(lines[0]).toBe('site.list: 1 of 7 sites');
    expect(lines[1]).toContain('live at https://launch-x1.moda.page');
    expect(lines[1]).toContain('unpublished changes');
  });

  test('no flags → no query string', async () => {
    const { base, calls } = serve(() => Response.json({ websites: [], total: 0, limit: 25, offset: 0 }));
    await performSiteList(client(base), {});
    expect(calls[0]?.search).toBe('');
  });
});

describe('site show (GET /v1/websites/{id})', () => {
  test('a pending_review site is never rendered as live', async () => {
    const { base, calls } = serve(() =>
      Response.json({
        website: website({ is_published: true, url: 'https://launch-x1.moda.page', review_status: 'pending_review' }),
      }),
    );
    const outcome = await performSiteShow(client(base), SITE_ID);
    expect(calls[0]?.path).toBe(`/v1/websites/${SITE_ID}`);
    const lines = humanLines(outcome);
    expect(lines[0]).toContain('published (held for review) — https://launch-x1.moda.page goes live once approved');
    expect(lines[0]).not.toContain('live at');
  });

  test('an approved live site renders as live', async () => {
    const { base } = serve(() =>
      Response.json({
        website: website({ is_published: true, url: 'https://launch-x1.moda.page', review_status: 'approved' }),
      }),
    );
    const lines = humanLines(await performSiteShow(client(base), SITE_ID));
    expect(lines[0]).toContain('live at https://launch-x1.moda.page');
  });
});

describe('site set-content (PUT /v1/websites/{id}/content)', () => {
  test('PUTs {html} and reminds about republish when the site is live', async () => {
    const { base, calls } = serve(() =>
      Response.json({
        operation: 'websites.update_content',
        website: website({ version: 3, is_published: true, has_unpublished_changes: true }),
      }),
    );
    const outcome = await performSiteSetContent(client(base), SITE_ID, { html: '<html>v3</html>' });
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.path).toBe(`/v1/websites/${SITE_ID}/content`);
    expect(calls[0]?.body).toEqual({ html: '<html>v3</html>' });
    const lines = humanLines(outcome);
    expect(lines[0]).toBe('site.set-content: saved (version 3)');
    expect(lines[1]).toBe(`the live site still serves the last publish — republish: moda site publish ${SITE_ID}`);
  });

  test('no republish reminder for an unpublished site', async () => {
    const { base } = serve(() => Response.json({ operation: 'websites.update_content', website: website({ version: 2 }) }));
    const lines = humanLines(await performSiteSetContent(client(base), SITE_ID, { html: '<html>v2</html>' }));
    expect(lines.length).toBe(1);
  });

  test('--expected-version travels as expected_version (read-modify-write guard)', async () => {
    const { base, calls } = serve(() =>
      Response.json({ operation: 'websites.update_content', website: website({ version: 4 }) }),
    );
    await performSiteSetContent(client(base), SITE_ID, { html: '<html>v4</html>', expectedVersion: 3 });
    expect(calls[0]?.body).toEqual({ html: '<html>v4</html>', expected_version: 3 });
  });

  test('409 website_version_conflict passes through with the re-read hint', async () => {
    const { base } = serve(
      () =>
        new Response(
          JSON.stringify({ error: { type: 'conflict', code: 'website_version_conflict', message: 'Version mismatch.' } }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    try {
      await performSiteSetContent(client(base), SITE_ID, { html: '<html>x</html>', expectedVersion: 2 });
      expect.unreachable();
    } catch (err) {
      const fields = (err as CliError).fields;
      expect(fields.code).toBe('website_version_conflict');
      expect(fields.type).toBe('conflict');
      expect(fields.hint).toContain(`moda site show ${SITE_ID}`);
    }
  });
});

describe('site publish (POST /v1/websites/{id}/publish)', () => {
  test('publishes with an empty body by default; prints the live URL; serving=true when approved', async () => {
    const { base, calls } = serve(() =>
      Response.json({
        operation: 'websites.publish',
        url: 'https://launch-x1.moda.page',
        slug: 'launch-x1',
        is_live: true,
        review_status: 'approved',
        published_at: '2026-08-11T01:00:00Z',
        warnings: [],
      }),
    );
    const outcome = await performSitePublish(client(base), SITE_ID, undefined);
    expect(calls[0]?.path).toBe(`/v1/websites/${SITE_ID}/publish`);
    expect(calls[0]?.body).toEqual({});
    const body = outcome.body as Record<string, unknown>;
    expect(body.operation).toBe('site.publish');
    expect(body.url).toBe('https://launch-x1.moda.page');
    expect(body.serving).toBe(true);
    expect(humanLines(outcome)[0]).toBe('site.publish: live at https://launch-x1.moda.page');
  });

  test('--slug travels as slug_prefix; pending_review stated honestly (serving=false); warnings surface', async () => {
    const { base, calls } = serve(() =>
      Response.json({
        operation: 'websites.publish',
        url: 'https://launch-x1.moda.page',
        slug: 'launch-x1',
        is_live: true,
        review_status: 'pending_review',
        published_at: '2026-08-11T01:00:00Z',
        warnings: ['an embed origin was stripped'],
      }),
    );
    const outcome = await performSitePublish(client(base), SITE_ID, 'launch');
    const lines = humanLines(outcome);
    expect(calls[0]?.body).toEqual({ slug_prefix: 'launch' });
    expect((outcome.body as Record<string, unknown>).serving).toBe(false);
    expect(lines[0]).toBe(
      'site.publish: published, but held for review before serving — https://launch-x1.moda.page goes live once approved',
    );
    expect(lines[1]).toBe('warning: an embed origin was stripped');
  });

  test('slug_taken is a 400 usage-class error, not retryable', async () => {
    const { base } = serve(
      () =>
        new Response(
          JSON.stringify({ error: { type: 'invalid_request', code: 'slug_taken', message: 'Slug is taken.' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    try {
      await performSitePublish(client(base), SITE_ID, 'launch');
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.code).toBe('slug_taken');
      expect((err as CliError).fields.type).toBe('invalid_request');
      expect((err as CliError).fields.retryable).toBe(false);
    }
  });

  test('website_already_published (concurrent first-publish race) carries the re-run guidance', async () => {
    const { base } = serve(
      () =>
        new Response(
          JSON.stringify({
            error: { type: 'conflict', code: 'website_already_published', message: 'Already published.' },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    try {
      await performSitePublish(client(base), SITE_ID, undefined);
      expect.unreachable();
    } catch (err) {
      const fields = (err as CliError).fields;
      expect(fields.code).toBe('website_already_published');
      // Contract-settled semantics: another publish won the first-publish race; a re-run succeeds.
      expect(fields.hint).toContain(`moda site publish ${SITE_ID}`);
      expect(fields.hint).toContain('it will succeed');
    }
  });
});

describe('site unpublish / delete', () => {
  test('unpublish POSTs and reports the slug down', async () => {
    const { base, calls } = serve(() =>
      Response.json({ operation: 'websites.unpublish', is_live: false, slug: 'launch-x1', unpublished_at: '2026-08-11T02:00:00Z' }),
    );
    const outcome = await performSiteUnpublish(client(base), SITE_ID);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe(`/v1/websites/${SITE_ID}/unpublish`);
    expect((outcome.body as Record<string, unknown>).operation).toBe('site.unpublish');
    expect(humanLines(outcome)[0]).toBe('site.unpublish: launch-x1 is no longer live');
  });

  test('unpublish with no live site passes through typed (404 no_active_published_site)', async () => {
    const { base } = serve(
      () =>
        new Response(
          JSON.stringify({ error: { type: 'not_found', code: 'no_active_published_site', message: 'Nothing is live.' } }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    try {
      await performSiteUnpublish(client(base), SITE_ID);
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.code).toBe('no_active_published_site');
      expect((err as CliError).fields.type).toBe('not_found');
    }
  });

  test('delete sends DELETE and confirms', async () => {
    const { base, calls } = serve(() => Response.json({ operation: 'websites.delete', deleted: true, id: SITE_ID }));
    const outcome = await performSiteDelete(client(base), SITE_ID);
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.path).toBe(`/v1/websites/${SITE_ID}`);
    expect((outcome.body as Record<string, unknown>).deleted).toBe(true);
    expect(humanLines(outcome)[0]).toBe(`site.delete: ${SITE_ID} deleted`);
  });
});
