/**
 * `canvas import-pages --source` ref acceptance (moda-video cold-gate finding F-V3): a pasted
 * canvas URL must resolve client-side through the refs.ts machinery (#23) instead of being sent
 * raw — the server treats a non-id `source` as a share TOKEN, so a raw URL used to fail with a
 * misleading `file_not_found` naming "token: http://…". Share URLs pass their bare token, so any
 * genuine share-link error names the REAL token.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { normalizeImportSource } from '../src/commands/canvasShared.ts';

const MAIN = resolve(import.meta.dir, '../src/main.ts');

const TARGET = 'cvs_01HZX9K2ABCDEFGHJKMNPQRSTV';
const SOURCE_WIRE = 'cvs_01HZX9K2ZZZZZZZZZZZZZZZZZZ';
const SOURCE_UUID = '018f3c6e-1234-4abc-9def-00112233aabb';

let server: ReturnType<typeof Bun.serve> | undefined;

interface Captured {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

function serve(
  respond: (body: Record<string, unknown>, url: URL) => Response | Promise<Response>,
): { base: string; calls: Captured[] } {
  const calls: Captured[] = [];
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      calls.push({ method: req.method, path: url.pathname, body });
      return respond(body, url);
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, calls };
}

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

async function runCli(args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      MODA_NO_UPDATE_CHECK: '1',
      MODA_STATE_DIR: mkdtempSync(join(tmpdir(), 'moda-import-src-')),
      MODA_API_KEY: 'moda_live_testkey000000',
    },
  });
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { code, stdout };
}

const importedOk = () =>
  Response.json({
    operation: 'canvas.import_pages',
    committed: true,
    detail: { imported_pages: [{ new_page_id: 'p_x', source_page_id: 'p_a', name: 'Page 1' }] },
  });

describe('normalizeImportSource (unit)', () => {
  test('non-URL inputs pass through untouched: wire id, UUID, bare share token', () => {
    expect(normalizeImportSource(SOURCE_WIRE)).toBe(SOURCE_WIRE);
    expect(normalizeImportSource(SOURCE_UUID)).toBe(SOURCE_UUID);
    expect(normalizeImportSource('shr_sometoken123')).toBe('shr_sometoken123');
    expect(normalizeImportSource(`  ${SOURCE_UUID}  `)).toBe(SOURCE_UUID);
  });

  test('pasted /canvas/<uuid> and /c/<cvs_id> app URLs yield the ref', () => {
    expect(normalizeImportSource(`https://moda.app/canvas/${SOURCE_UUID}`)).toBe(SOURCE_UUID);
    expect(normalizeImportSource(`http://localhost:3000/canvas/${SOURCE_UUID}`)).toBe(SOURCE_UUID);
    expect(normalizeImportSource(`https://moda.app/c/${SOURCE_WIRE}`)).toBe(SOURCE_WIRE);
  });

  test('query strings and uppercase schemes still parse (clipboard realities)', () => {
    expect(normalizeImportSource(`https://moda.app/canvas/${SOURCE_UUID}?page=2`)).toBe(SOURCE_UUID);
    expect(normalizeImportSource(`HTTPS://moda.app/c/${SOURCE_WIRE}`)).toBe(SOURCE_WIRE);
  });

  test('a pasted /s/<token> share URL yields the BARE token (accurate server error copy)', () => {
    expect(normalizeImportSource('https://moda.app/s/tok_abc123')).toBe('tok_abc123');
  });
});

describe('canvas import-pages --source wiring', () => {
  test('a pasted canvas URL sends the extracted id, never the URL', async () => {
    const { base, calls } = serve(() => importedOk());
    const { code } = await runCli([
      'canvas', 'import-pages', TARGET,
      '--source', `https://moda.app/canvas/${SOURCE_UUID}`,
      '--json', '--api-base', base,
    ]);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.source).toBe(SOURCE_UUID);
  });

  test('a pasted share URL sends the bare token, so a share-link 404 names the real token', async () => {
    // The stub ECHOES the source it received into the error copy — the assertions below only
    // pass when the CLI sent the bare token, not the raw URL (the pre-fix failure mode).
    const { base, calls } = serve((body) =>
      Response.json(
        {
          error: {
            type: 'not_found',
            code: 'file_not_found',
            message: `Share link not found or has been deleted (token: ${String(body.source)})`,
          },
        },
        { status: 404 },
      ),
    );
    const { code, stdout } = await runCli([
      'canvas', 'import-pages', TARGET,
      '--source', 'https://moda.app/s/tok_abc123',
      '--json', '--api-base', base,
    ]);
    expect(code).not.toBe(0);
    expect(calls[0]?.body.source).toBe('tok_abc123');
    const error = (JSON.parse(stdout) as Record<string, unknown>).error as Record<string, unknown>;
    // The surfaced error copy names the actual token — not a "token" that is a mangled URL.
    expect(String(error.message)).toContain('tok_abc123');
    expect(String(error.message)).not.toContain('http');
  });

  test('an unresolvable pasted URL fails locally as usage, before any API call', async () => {
    const { base, calls } = serve(() => importedOk());
    const { code, stdout } = await runCli([
      'canvas', 'import-pages', TARGET,
      '--source', 'https://moda.app/brand-kit/not-a-canvas-url',
      '--json', '--api-base', base,
    ]);
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    const error = (JSON.parse(stdout) as Record<string, unknown>).error as Record<string, unknown>;
    expect(error.code).toBe('usage');
  });

  test('a bad --source fails before the TARGET share-URL resolution round-trip', async () => {
    const { base, calls } = serve(() => importedOk());
    const { code } = await runCli([
      'canvas', 'import-pages', 'https://moda.app/s/target_tok',
      '--source', 'https://moda.app/brand-kit/not-a-canvas-url',
      '--json', '--api-base', base,
    ]);
    expect(code).toBe(2);
    expect(calls).toHaveLength(0); // no /v1/share_links/resolve spent on a doomed invocation
  });

  test('a bare share token still passes through verbatim', async () => {
    const { base, calls } = serve(() => importedOk());
    const { code } = await runCli([
      'canvas', 'import-pages', TARGET,
      '--source', 'tok_abc123',
      '--json', '--api-base', base,
    ]);
    expect(code).toBe(0);
    expect(calls[0]?.body.source).toBe('tok_abc123');
  });
});
