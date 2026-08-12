/**
 * Team templates (wave-2 G7): the `moda template list` cursor lane, the `moda template pull`
 * raw write that keeps signed thumbnail URLs fetchable (and the redaction contrast that
 * motivates it), and `moda canvas create --template`'s payload + mutual-exclusion guard.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const MAIN = resolve(import.meta.dir, '../src/main.ts');

const THUMB_SIG = 'deadbeefcafe0001';
const THUMB_URL = `https://storage.googleapis.com/moda/thumbs/t1.png?X-Goog-Expires=86400&X-Goog-Signature=${THUMB_SIG}`;

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
      return await respond(req, url);
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, calls };
}

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

async function run(args: string[], base?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const scratch = mkdtempSync(join(tmpdir(), 'moda-templates-'));
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      MODA_NO_UPDATE_CHECK: '1',
      MODA_CONFIG_DIR: join(scratch, 'config'),
      MODA_STATE_DIR: join(scratch, 'state'),
      MODA_API_KEY: 'moda_live_testkey000000',
      ...(base !== undefined ? { MODA_API_BASE: base } : {}),
    },
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function scratchFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'moda-templates-out-')), name);
}

/** The shipped envelope: cursor lane (#9317 uniform shape), items under `data`, true total. */
function templatePage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: [
      {
        id: 'cvs_01HZXTEMPLATE0001',
        uuid: '2c9a4f10-9c4d-4e8f-b1a2-5d6e7f809012',
        name: 'Q3 QBR deck',
        category: 'slides',
        page_count: 12,
        description: 'The standard quarterly business review deck.',
        tags: ['qbr', 'internal'],
        thumbnail_url: THUMB_URL,
        created_at: '2026-07-01T00:00:00Z',
        updated_at: '2026-08-01T00:00:00Z',
      },
    ],
    next_cursor: null,
    returned: 1,
    has_more: false,
    limit: 20,
    total: 1,
    ...overrides,
  };
}

describe('moda template list (cursor lane)', () => {
  test('renders id, name, category and page count; the page note reflects the true total', async () => {
    const { base, calls } = serve(() => Response.json(templatePage()));
    const { code, stdout } = await run(['template', 'list'], base);
    expect(code).toBe(0);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.path).toBe('/v1/templates');
    const lines = stdout.trim().split('\n');
    expect(lines[0]).toBe('cvs_01HZXTEMPLATE0001  Q3 QBR deck  [slides · 12 pages]');
    expect(lines[1]).toBe('showing all 1');
  });

  test('a null category and a missing page_count degrade to a bare id + name line', async () => {
    const { base } = serve(() =>
      Response.json(
        templatePage({
          data: [{ id: 'cvs_bare', name: 'Untitled template', category: null, thumbnail_url: null }],
        }),
      ),
    );
    const { code, stdout } = await run(['template', 'list'], base);
    expect(code).toBe(0);
    expect(stdout.trim().split('\n')[0]).toBe('cvs_bare  Untitled template');
  });

  test('--limit passes through; --all follows next_cursor (never offset) and merges pages', async () => {
    const { base, calls } = serve((_req, url) => {
      const cursor = url.searchParams.get('cursor');
      if (cursor === null) {
        return Response.json({
          data: [{ id: 'cvs_a', name: 'A', category: 'slides', page_count: 3 }],
          next_cursor: 'c_page2',
          returned: 1,
          has_more: true,
          limit: 1,
          total: 2,
        });
      }
      return Response.json({
        data: [{ id: 'cvs_b', name: 'B', category: 'social', page_count: 1 }],
        next_cursor: null,
        returned: 1,
        has_more: false,
        limit: 1,
        total: 2,
      });
    });
    const { code, stdout } = await run(['template', 'list', '--limit', '1', '--all', '--json'], base);
    expect(code).toBe(0);
    expect(calls[0]?.search).toBe('?limit=1');
    expect(calls[1]?.search).toBe('?limit=1&cursor=c_page2');
    const body = JSON.parse(stdout) as Record<string, unknown>;
    expect(body.operation).toBe('template.list');
    expect(body.returned).toBe(2);
    expect(body.total).toBe(2);
    expect((body.data as Array<Record<string, unknown>>).map((t) => t.id)).toEqual(['cvs_a', 'cvs_b']);
  });

  test('an empty team gets the actionable empty hint, not a bare blank', async () => {
    const { base } = serve(() =>
      Response.json({ data: [], next_cursor: null, returned: 0, has_more: false, limit: 20, total: 0 }),
    );
    const { code, stdout } = await run(['template', 'list'], base);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('no team templates — mark canvases as templates in the app, or create from scratch');
  });
});

describe('moda template pull (the thumbnail read)', () => {
  test('writes the RAW payload — the signed thumbnail URL survives and stays fetchable', async () => {
    const { base, calls } = serve(() => Response.json(templatePage()));
    const out = scratchFile('templates.json');
    const { code, stdout } = await run(['template', 'pull', '--output', out, '--limit', '5', '--json'], base);
    expect(code).toBe(0);
    expect(calls[0]?.path).toBe('/v1/templates');
    expect(calls[0]?.search).toBe('?limit=5');
    const written = readFileSync(out, 'utf8');
    expect(written).toContain(`X-Goog-Signature=${THUMB_SIG}`);
    expect(written).not.toContain('[REDACTED]');
    const body = JSON.parse(stdout) as Record<string, unknown>;
    expect(body.operation).toBe('template.pull');
    expect(body.returned).toBe(1);
    expect(body.output).toBe(out);
  });

  test('CONTRAST: the same URL through the normal emit path comes out [REDACTED]', async () => {
    const { base } = serve(() => Response.json(templatePage()));
    const listOut = scratchFile('list.json');
    const { code, stdout } = await run(['template', 'list', '--output', listOut, '--json'], base);
    expect(code).toBe(0);
    // --output on a list verb rides writeResultFile → redactValue: signature material is gone.
    const listFile = readFileSync(listOut, 'utf8');
    expect(listFile).not.toContain(THUMB_SIG);
    expect(listFile).toContain('X-Goog-Signature=[REDACTED]');
    // …and so is it on stdout.
    expect(stdout).not.toContain(THUMB_SIG);
  });

  test('--output is required (the payload never lands on stdout)', async () => {
    const { code } = await run(['template', 'pull']);
    expect(code).toBe(2);
  });
});

describe('moda canvas create --template', () => {
  test('sends template_canvas_id and nothing else about geometry', async () => {
    const { base, calls } = serve(() =>
      Response.json({
        operation: 'canvas.create',
        canvas: { id: 'cvs_new0001', uuid: '3f2b7a10-9c4d-4e8f-b1a2-5d6e7f809012' },
        source_canvas: { id: 'cvs_01HZXTEMPLATE0001', uuid: '2c9a4f10-9c4d-4e8f-b1a2-5d6e7f809012' },
      }),
    );
    const { code, stdout } = await run(
      ['canvas', 'create', '--name', 'Q3 QBR', '--template', 'cvs_01HZXTEMPLATE0001', '--json'],
      base,
    );
    expect(code).toBe(0);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/v1/canvases');
    expect(calls[0]?.body.template_canvas_id).toBe('cvs_01HZXTEMPLATE0001');
    expect(calls[0]?.body.name).toBe('Q3 QBR');
    expect(calls[0]?.body.width).toBeUndefined();
    expect(calls[0]?.body.page_count).toBeUndefined();
    expect(calls[0]?.body.category).toBeUndefined();
    const body = JSON.parse(stdout) as Record<string, unknown>;
    expect((body.source_canvas as Record<string, unknown>).id).toBe('cvs_01HZXTEMPLATE0001');
  });

  test('--template with --size/--pages/--category is a local usage error — exit 2, no HTTP call', async () => {
    for (const extra of [
      ['--size', '1920x1080'],
      ['--pages', '4'],
      ['--category', 'slides'],
    ]) {
      const { base, calls } = serve(() => Response.json({ operation: 'canvas.create' }));
      const { code, stdout } = await run(
        ['canvas', 'create', '--name', 'N', '--template', 'cvs_x', ...extra, '--json'],
        base,
      );
      expect(code).toBe(2);
      expect(calls.length).toBe(0);
      const error = (JSON.parse(stdout) as Record<string, unknown>).error as Record<string, unknown>;
      expect(error.code).toBe('usage');
      expect(String(error.message)).toContain(extra[0] as string);
      expect(String(error.hint)).toContain('--template');
      server?.stop(true);
      server = undefined;
    }
  });
});

describe('verb registration', () => {
  test('both verbs are classified pure reads in the machine-readable schema', async () => {
    for (const verb of ['list', 'pull']) {
      const { code, stdout } = await run(['describe', 'template', verb, '--json']);
      expect(code).toBe(0);
      const described = (JSON.parse(stdout) as Record<string, unknown>).verb as Record<string, unknown>;
      expect(described.name).toBe(`template ${verb}`);
      expect(described.markers).toEqual({ mutating: false, destructive: false, metered: false, read_lane: false });
    }
  });

  test('canvas create advertises --template, and both verbs document the list/pull split', async () => {
    const create = await run(['canvas', 'create', '--help']);
    expect(create.stdout).toContain('--template');
    const list = await run(['template', 'list', '--help']);
    expect(list.stdout).toContain('moda template pull');
    const pull = await run(['template', 'pull', '--help']);
    expect(pull.stdout).toContain('use-and-discard');
  });
});
