/**
 * The shared open lane (`<noun> open`): server-provided app URL first, the documented
 * constructed fallback second — pinning the REAL frontend routes (/canvas/<uuid>,
 * /brand-kit/<uuid>, /website/<uuid>, /files/folder/<uuid>) with bare UUIDs. Regression
 * anchor: `canvas open` once built /c/<ref> (the API examples' shape) — a URL nothing serves.
 * Launch failure is non-fatal by contract: exit 0, URL on stdout, stderr note.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ApiClient } from '../src/api/client.ts';
import { CliError } from '../src/cliError.ts';
import { buildProgram } from '../src/main.ts';
import { collectVerbs } from '../src/commands/meta.ts';
import { performBrandOpen } from '../src/commands/brand.ts';
import { performCanvasOpen } from '../src/commands/canvas.ts';
import { performDriveOpen } from '../src/commands/drive.ts';
import { performSiteOpen } from '../src/commands/site.ts';
import type { OpenLaneContext } from '../src/commands/open.ts';
import { toWireId, wireIdToUuid } from '../src/refs.ts';

const UUID = '018f3c6e-1234-4abc-9def-00112233aabb';
const CVS = toWireId('canvas', UUID);
const BK = 'bk_01HZX9K2ABCDEFGHJKMNPQRSTV';
const BK_UUID = wireIdToUuid(BK) as string;
const FLD = toWireId('folder', UUID);

const APP_BASE = 'https://moda.app';

let server: ReturnType<typeof Bun.serve> | undefined;

function serve(respond: (req: Request, url: URL) => Response): { base: string; paths: string[] } {
  const paths: string[] = [];
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      paths.push(url.pathname);
      return respond(req, url);
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, paths };
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
    env: { MODA_STATE_DIR: '/tmp/moda-open-test-state' },
  });
}

interface LaunchLog {
  ctx: OpenLaneContext;
  launched: string[];
  notes: string[];
}

function testContext(launchResult = true): LaunchLog {
  const launched: string[] = [];
  const notes: string[] = [];
  const ctx: OpenLaneContext = {
    appBase: APP_BASE,
    env: {},
    note: (message) => notes.push(message),
    launch: async (url) => {
      launched.push(url);
      return launchResult;
    },
  };
  return { ctx, launched, notes };
}

function json(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('canvas open', () => {
  test('opens the SERVER-provided editor URL verbatim when the read returns one', async () => {
    const serverUrl = `https://moda.app/canvas/${UUID}`;
    const { base } = serve(() => json({ canvas_id: CVS, canvas_url: serverUrl, name: 'Deck' }));
    const { ctx, launched } = testContext();
    const outcome = await performCanvasOpen(client(base), ctx, CVS);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.body.url).toBe(serverUrl);
    expect(outcome.body.url_source).toBe('server');
    expect(launched).toEqual([serverUrl]);
  });

  test('REGRESSION: constructed fallback is /canvas/<bare-uuid> — never /c/, never the cvs_ form', async () => {
    const { base } = serve(() => json({ canvas_id: CVS, name: 'Deck' })); // server predates the URL field
    const { ctx, launched } = testContext();
    const outcome = await performCanvasOpen(client(base), ctx, CVS);
    expect(outcome.body.url).toBe(`${APP_BASE}/canvas/${UUID}`);
    expect(outcome.body.url_source).toBe('constructed');
    expect(String(outcome.body.url)).not.toContain('/c/');
    expect(String(outcome.body.url)).not.toContain('cvs_');
    expect(launched).toEqual([`${APP_BASE}/canvas/${UUID}`]);
  });

  test('a UUID ref constructs from the ref itself when the response carries no ids', async () => {
    const { base } = serve(() => json({ name: 'Deck' }));
    const { ctx } = testContext();
    const outcome = await performCanvasOpen(client(base), ctx, UUID);
    expect(outcome.body.url).toBe(`${APP_BASE}/canvas/${UUID}`);
  });

  test('launch failure never fails the verb: exit 0, opened false, stderr note with the URL', async () => {
    const serverUrl = `https://moda.app/canvas/${UUID}`;
    const { base } = serve(() => json({ canvas_id: CVS, canvas_url: serverUrl }));
    const { ctx, notes } = testContext(false);
    const outcome = await performCanvasOpen(client(base), ctx, CVS);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.body.opened).toBe(false);
    expect(notes.join('\n')).toContain(serverUrl);
    // The URL is the human output either way.
    const lines: string[] = [];
    outcome.human?.((line) => lines.push(line));
    expect(lines).toEqual([serverUrl]);
  });
});

describe('brand open', () => {
  test("uses the kit's app editor `url` (nested under brand_kit)", async () => {
    const serverUrl = `https://moda.app/brand-kit/${BK_UUID}`;
    const { base } = serve(() =>
      json({ brand_kit: { url: serverUrl, title: 'Acme', company_url: 'https://acme.example' }, id: BK, uuid: BK_UUID }),
    );
    const { ctx, launched } = testContext();
    const outcome = await performBrandOpen(client(base), ctx, BK);
    expect(outcome.body.url).toBe(serverUrl);
    expect(outcome.body.url_source).toBe('server');
    expect(launched).toEqual([serverUrl]);
  });

  test('never opens the company website: fallback is /brand-kit/<uuid> when no app URL field exists', async () => {
    const { base } = serve(() => json({ brand_kit: { title: 'Acme', company_url: 'https://acme.example' }, id: BK, uuid: BK_UUID }));
    const { ctx, launched } = testContext();
    const outcome = await performBrandOpen(client(base), ctx, BK);
    expect(outcome.body.url).toBe(`${APP_BASE}/brand-kit/${BK_UUID}`);
    expect(outcome.body.url_source).toBe('constructed');
    expect(launched[0]).not.toContain('acme.example');
  });
});

describe('site open', () => {
  test('prefers editor_url and NEVER the published-site url', async () => {
    const editorUrl = `https://moda.app/website/${UUID}`;
    const { base } = serve(() =>
      json({ website: { id: UUID, url: 'https://launch.moda.page', editor_url: editorUrl, is_published: true } }),
    );
    const { ctx, launched } = testContext();
    const outcome = await performSiteOpen(client(base), ctx, UUID);
    expect(outcome.body.url).toBe(editorUrl);
    expect(launched).toEqual([editorUrl]);
  });

  test('without editor_url the published url is ignored and /website/<uuid> is constructed', async () => {
    const { base } = serve(() => json({ website: { id: UUID, url: 'https://launch.moda.page', is_published: true } }));
    const { ctx } = testContext();
    const outcome = await performSiteOpen(client(base), ctx, UUID);
    expect(outcome.body.url).toBe(`${APP_BASE}/website/${UUID}`);
    expect(outcome.body.url_source).toBe('constructed');
  });

  test('accepts a pasted /website/<uuid> URL as the ref', async () => {
    const { base, paths } = serve(() => json({ website: { id: UUID } }));
    const { ctx } = testContext();
    await performSiteOpen(client(base), ctx, `https://moda.app/website/${UUID}`);
    expect(paths).toEqual([`/v1/websites/${UUID}`]);
  });
});

describe('drive open', () => {
  test('uses the folder row app_url when the server provides one', async () => {
    const serverUrl = `https://moda.app/files/folder/${UUID}`;
    const { base } = serve(() =>
      json({ folders: [{ id: FLD, name: 'Acme', path: '/Acme', app_url: serverUrl }], returned: 1, total: 1, has_more: false }),
    );
    const { ctx, launched } = testContext();
    const outcome = await performDriveOpen(client(base), ctx, FLD);
    expect(outcome.body.url).toBe(serverUrl);
    expect(outcome.body.url_source).toBe('server');
    expect(launched).toEqual([serverUrl]);
  });

  test('constructs /files/folder/<bare-uuid> from the fld_ wire id when the field is absent', async () => {
    const { base } = serve(() => json({ folders: [{ id: FLD, name: 'Acme', path: '/Acme' }], returned: 1, total: 1, has_more: false }));
    const { ctx } = testContext();
    const outcome = await performDriveOpen(client(base), ctx, FLD);
    expect(outcome.body.url).toBe(`${APP_BASE}/files/folder/${UUID}`);
    expect(String(outcome.body.url)).not.toContain('fld_');
  });

  test('a UUID folder ref matches the fld_ row via wire encoding', async () => {
    const { base } = serve(() => json({ folders: [{ id: FLD, name: 'Acme', path: '/Acme' }], returned: 1, total: 1, has_more: false }));
    const { ctx } = testContext();
    const outcome = await performDriveOpen(client(base), ctx, UUID);
    expect(outcome.body.url).toBe(`${APP_BASE}/files/folder/${UUID}`);
  });

  test('an unknown folder is a typed not_found with the folders steer', async () => {
    const { base } = serve(() => json({ folders: [], returned: 0, total: 0, has_more: false }));
    const { ctx } = testContext();
    try {
      await performDriveOpen(client(base), ctx, FLD);
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.type).toBe('not_found');
      expect((err as CliError).fields.hint).toContain('moda drive folders');
    }
  });
});

describe('verb registration + markers', () => {
  const verbs = collectVerbs(buildProgram(), '');
  const byName = new Map(verbs.map((verb) => [verb.name, verb]));

  test('the four open verbs are registered, marker-free (read + local side effect)', () => {
    for (const name of ['canvas open', 'brand open', 'site open', 'drive open']) {
      const verb = byName.get(name);
      expect(verb?.description.length ?? 0).toBeGreaterThan(0);
      expect(verb?.markers).toEqual({ mutating: false, destructive: false, metered: false, read_lane: false });
    }
  });
});
