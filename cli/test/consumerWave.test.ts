/**
 * v0.4.0 consumer wave: site multi-page verbs + screenshots, canvas import-pages/duplicate/
 * instructions, brand guide reads, mp4/gif export acceptance.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient } from '../src/api/client.ts';
import { CliError } from '../src/cliError.ts';
import type { Invocation } from '../src/commands/runtime.ts';
import { toWireId } from '../src/refs.ts';
import { validateRoutePath } from '../src/commands/site.ts';
import { performExport } from '../src/commands/export.ts';
import {
  performSiteAddPage,
  performSiteDeletePage,
  performSitePageSetContent,
  performSitePages,
  performSiteScreenshot,
} from '../src/commands/site.ts';

const SITE_ID = '3f2b7a10-9c4d-4e8f-b1a2-5d6e7f809012';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

let server: ReturnType<typeof Bun.serve> | undefined;

interface Captured {
  method: string;
  path: string;
  search: string;
  body: Record<string, unknown>;
}

function serve(respond: (req: Request, url: URL) => Response | Promise<Response>): { base: string; calls: Captured[] } {
  const calls: Captured[] = [];
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      calls.push({ method: req.method, path: url.pathname, search: url.search, body });
      return respond(req, url);
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
    sleeper: async () => {},
    env: { MODA_STATE_DIR: '/tmp/moda-consumer-test' },
  });
}

function fakeInv(): Invocation {
  return { flags: {}, env: {}, note: () => {} } as unknown as Invocation;
}

function humanLines(outcome: { human?: (write: (line: string) => void) => void }): string[] {
  const lines: string[] = [];
  outcome.human?.((line) => lines.push(line));
  return lines;
}

describe('site multi-page verbs (#9288 contract)', () => {
  test('pages: GET list with version line', async () => {
    const { base, calls } = serve(() =>
      Response.json({ pages: [{ path: '/', name: 'Home' }, { path: '/pricing', name: 'Pricing' }], total: 2, version: 7 }),
    );
    const outcome = await performSitePages(client(base), SITE_ID);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.path).toBe(`/v1/websites/${SITE_ID}/pages`);
    const lines = humanLines(outcome);
    expect(lines[0]).toBe('/  Home');
    expect(lines[2]).toBe('2 pages; version: 7');
  });

  test('set-content --path rides PUT /pages/content with expected_version', async () => {
    const { base, calls } = serve(() =>
      Response.json({ operation: 'websites.update_page_content', page: { path: '/pricing' }, website: { version: 8, is_published: true } }),
    );
    const outcome = await performSitePageSetContent(client(base), SITE_ID, {
      path: '/pricing',
      html: '<html>p</html>',
      expectedVersion: 7,
    });
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.path).toBe(`/v1/websites/${SITE_ID}/pages/content`);
    expect(calls[0]?.body).toEqual({ path: '/pricing', html: '<html>p</html>', expected_version: 7 });
    expect(humanLines(outcome)[0]).toBe('site.set-content: /pricing saved (version 8)');
  });

  test('add-page POSTs with idempotency; page-exists conflict carries the set-content hint', async () => {
    const { base, calls } = serve(() =>
      Response.json({ operation: 'websites.add_page', page: { path: '/pricing', name: 'Pricing', is_home: false }, website: { version: 9 } }),
    );
    await performSiteAddPage(client(base), SITE_ID, { path: '/pricing', html: '<html>p</html>', name: 'Pricing' });
    expect(calls[0]?.body.path).toBe('/pricing');
    expect(calls[0]?.body.name).toBe('Pricing');
    expect(typeof calls[0]?.body.idempotency_key).toBe('string');

    server?.stop(true);
    const failing = serve(
      () =>
        new Response(
          JSON.stringify({ error: { type: 'conflict', code: 'website_page_exists', message: 'exists' } }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    try {
      await performSiteAddPage(client(failing.base), SITE_ID, { path: '/pricing', html: '<html>p</html>' });
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.hint).toContain('moda site set-content');
      expect((err as CliError).fields.hint).toContain('--path /pricing');
    }
  });

  test('delete-page sends QUERY params; homepage protection carries the replace hint', async () => {
    const { base, calls } = serve(() =>
      Response.json({ operation: 'websites.delete_page', deleted: true, page: { path: '/pricing' }, website: { version: 10 } }),
    );
    await performSiteDeletePage(client(base), SITE_ID, { path: '/pricing', expectedVersion: 9 });
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.search).toBe(`?path=${encodeURIComponent('/pricing')}&expected_version=9`);

    server?.stop(true);
    const failing = serve(
      () =>
        new Response(
          JSON.stringify({ error: { type: 'unprocessable', code: 'website_home_page_protected', message: 'no' } }),
          { status: 422, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    try {
      await performSiteDeletePage(client(failing.base), SITE_ID, { path: '/' });
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.hint).toContain('cannot be deleted');
    }
  });

  test('screenshot: signed URLs downloaded to files; envelope points at files, never URLs', async () => {
    const { base, calls } = serve((req, url) => {
      if (url.pathname.endsWith('/screenshot')) {
        return Response.json({
          operation: 'websites.screenshot',
          id: SITE_ID,
          format: 'jpg',
          images: [
            { path: '/', viewport: 'desktop', url: `${base}/signed/home.jpg`, width: 1440, height: 2200, bytes: 4, truncated: false, js_disabled: false },
            { path: '/pricing', viewport: 'desktop', url: `${base}/signed/pricing.jpg`, width: 1440, height: 1800, bytes: 4, truncated: false, js_disabled: true },
          ],
        });
      }
      return new Response(PNG, { status: 200 });
    });
    const dir = mkdtempSync(join(tmpdir(), 'moda-siteshot-'));
    const outcome = await performSiteScreenshot(client(base), fakeInv(), SITE_ID, {
      paths: ['/', '/pricing'],
      viewport: 'desktop',
      format: 'jpg',
      output: dir,
    });
    expect(calls[0]?.body).toEqual({ paths: ['/', '/pricing'], viewport: 'desktop', format: 'jpg' });
    const body = outcome.body as Record<string, unknown>;
    const images = body.images as Array<Record<string, unknown>>;
    expect(images[0]?.url).toBeUndefined();
    expect(existsSync(String(images[0]?.file))).toBe(true);
    const lines = humanLines(outcome);
    expect(lines[0]).toContain('/ [desktop] → ');
    expect(lines[1]).toContain('rendered with JS off (degraded)');
  });
});

describe('review batch regressions', () => {
  test('B5: a failed download marks ITS image; the sibling keeps the right file', async () => {
    const { base } = serve((req, url) => {
      if (url.pathname.endsWith('/screenshot')) {
        return Response.json({
          operation: 'websites.screenshot',
          id: SITE_ID,
          format: 'jpg',
          images: [
            { path: '/', viewport: 'desktop', url: `${base}/signed/missing.jpg?fail=1`, width: 1440, height: 100 },
            { path: '/pricing', viewport: 'desktop', url: `${base}/signed/ok.jpg`, width: 1440, height: 100 },
          ],
        });
      }
      if (url.searchParams.get('fail') === '1' || url.pathname.includes('missing')) {
        return new Response('gone', { status: 403 });
      }
      return new Response(PNG, { status: 200 });
    });
    const dir = mkdtempSync(join(tmpdir(), 'moda-shotfail-'));
    const outcome = await performSiteScreenshot(client(base), fakeInv(), SITE_ID, {
      paths: ['/', '/pricing'],
      viewport: 'desktop',
      format: 'jpg',
      output: dir,
    });
    const images = (outcome.body as Record<string, unknown>).images as Array<Record<string, unknown>>;
    expect(images[0]?.download_failed).toBe(true);
    expect(images[0]?.file).toBeUndefined();
    expect(String(images[1]?.file)).toContain('_pricing');
    expect(existsSync(String(images[1]?.file))).toBe(true);
  });

  test('M8 + route grammar: local bounds fail clean', async () => {
    const c = client('http://127.0.0.1:1');
    await expect(
      performSiteScreenshot(c, fakeInv(), SITE_ID, { paths: ['/a', '/b', '/c', '/d'], viewport: 'desktop', format: 'jpg' }),
    ).rejects.toThrow(CliError);
    await expect(
      performSiteScreenshot(c, fakeInv(), SITE_ID, { viewport: 'desktop', format: 'jpg', scale: Number.NaN }),
    ).rejects.toThrow(CliError);
    expect(() => validateRoutePath('/_moda/x')).toThrow(CliError);
    expect(() => validateRoutePath('/has space')).toThrow(CliError);
    expect(validateRoutePath('/docs/faq-2')).toBe('/docs/faq-2');
  });

  test('N1: set-content passes an out-of-grammar path through to the server (escape hatch)', async () => {
    const { base, calls } = serve(() =>
      Response.json({ operation: 'websites.update_page_content', website: { version: 3 } }),
    );
    await performSitePageSetContent(client(base), SITE_ID, { path: '/legacy path!', html: '<html>x</html>' });
    expect(calls[0]?.body.path).toBe('/legacy path!');
  });

  test('M1: bare UUIDs encode to the 26-char Crockford cvs_ wire form; cvs_ passes through', () => {
    const wire = toWireId('canvas', '018f3c6e-1234-4abc-9def-00112233aabb');
    expect(wire).toMatch(/^cvs_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(toWireId('canvas', 'cvs_01HZX9K2ABCDEFGHJKMNPQRSTV')).toBe('cvs_01HZX9K2ABCDEFGHJKMNPQRSTV');
    // Deterministic and injective on distinct UUIDs.
    expect(toWireId('canvas', '018f3c6e-1234-4abc-9def-00112233aabb')).toBe(wire);
    expect(toWireId('canvas', '018f3c6e-1234-4abc-9def-00112233aabc')).not.toBe(wire);
  });

  test('M3: mp4/gif without --page is a clean local usage error', async () => {
    const inv = { flags: {}, context: { outputDir: { value: '.' }, apiBase: { value: 'http://127.0.0.1:1' } }, env: {}, note: () => {} } as never;
    try {
      await performExport(client('http://127.0.0.1:1'), inv, 'cvs_01HZX9K2ABCDEFGHJKMNPQRSTV', { format: 'mp4', wait: true });
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.code).toBe('usage');
      expect((err as CliError).fields.message).toContain('--page');
    }
  });
});
