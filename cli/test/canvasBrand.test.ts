/**
 * Binding a canvas to a brand kit (ENG-5161).
 *
 * Authoring a kit's palette into markup is what makes a design LOOK on-brand;
 * the binding is what makes the canvas BE on-brand — it is the key the editor's
 * brand-kit dropdown reads and the one Moda's own agent inherits for the user's
 * next edit. Before this, the deterministic lane could do the first and had no
 * way to do the second, so an agent-built deck opened with an empty dropdown.
 *
 * Pinned here: the wire contracts (create carries the kit, PATCH binds and
 * unbinds) and the two refusals that would otherwise be silent — a contradictory
 * bind+clear, and a kit passed alongside a template source that keeps its own.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildProgram } from '../src/main.ts';
import { collectVerbs } from '../src/commands/meta.ts';
import { toWireId } from '../src/refs.ts';

const MAIN = resolve(import.meta.dir, '../src/main.ts');
const UUID = '018f3c6e-1234-4abc-9def-00112233aabb';
const CVS = toWireId('canvas', UUID);
const BK = 'bk_01HZX9K2ABCDEFGHJKMNPQRSTV';

let server: ReturnType<typeof Bun.serve> | undefined;

interface Captured {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

function serve(respond: (req: Request, url: URL) => Response): { base: string; calls: Captured[] } {
  const calls: Captured[] = [];
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      calls.push({ method: req.method, path: url.pathname, body });
      return respond(req, url);
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, calls };
}

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function json(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function runCli(args: string[], base?: string): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(['bun', MAIN, ...args, '--json'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      MODA_NO_UPDATE_CHECK: '1',
      MODA_STATE_DIR: mkdtempSync(join(tmpdir(), 'moda-canvas-brand-cli-')),
      ...(base !== undefined ? { MODA_API_BASE: base, MODA_API_KEY: 'moda_live_testkey000000' } : {}),
    },
  });
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { code, stdout };
}

describe('verb registration', () => {
  test('`canvas brand` is registered and described', () => {
    const verbs = new Map(collectVerbs(buildProgram(), '').map((v) => [v.name, v]));
    expect((verbs.get('canvas brand')?.description ?? '').length).toBeGreaterThan(0);
  });

  test('`canvas create` advertises --brand', () => {
    const verbs = new Map(collectVerbs(buildProgram(), '').map((v) => [v.name, v]));
    const flags = (verbs.get('canvas create')?.flags ?? []).map((f: { flag: string }) => f.flag);
    expect(flags).toContain('--brand');
  });
});

describe('canvas create --brand', () => {
  test('sends brand_kit_id on the create body', async () => {
    const { base, calls } = serve(() => json({ operation: 'canvas.create', canvas: { id: CVS }, page_ids: ['p_a'] }));
    const { code } = await runCli(['canvas', 'create', '--name', 'Deck', '--brand', BK], base);
    expect(code).toBe(0);
    const create = calls.find((c) => c.method === 'POST');
    expect(create?.body.brand_kit_id).toBe(BK);
  });

  test('omitting --brand sends no brand_kit_id at all — the team default is never assumed', async () => {
    const { base, calls } = serve(() => json({ operation: 'canvas.create', canvas: { id: CVS }, page_ids: ['p_a'] }));
    await runCli(['canvas', 'create', '--name', 'Deck'], base);
    expect(calls[0]?.body).not.toHaveProperty('brand_kit_id');
  });

  test('refuses --brand with --template locally: the copy keeps the SOURCE canvas kit', async () => {
    // Refused before any request goes out — the server would 422 it, and naming
    // the follow-up call here saves the round trip and teaches the remedy.
    const { code, stdout } = await runCli(['canvas', 'create', '--name', 'Copy', '--template', CVS, '--brand', BK]);
    expect(code).toBe(2);
    const error = (JSON.parse(stdout) as { error: Record<string, unknown> }).error;
    expect(error.code).toBe('usage');
    expect(String(error.hint)).toContain('moda canvas brand');
  });
});

describe('canvas brand', () => {
  test('binds via PATCH with the kit ref', async () => {
    const { base, calls } = serve(() => json({ id: CVS, name: 'Deck', brand_kit_id: BK }));
    const { code } = await runCli(['canvas', 'brand', CVS, BK], base);
    expect(code).toBe(0);
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({ brand_kit_id: BK });
  });

  test('--clear sends an explicit null, because omitted means "leave it alone"', async () => {
    const { base, calls } = serve(() => json({ id: CVS, name: 'Deck', brand_kit_id: null }));
    const { code } = await runCli(['canvas', 'brand', CVS, '--clear'], base);
    expect(code).toBe(0);
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({ brand_kit_id: null });
    expect(Object.keys(patch?.body ?? {})).toContain('brand_kit_id');
  });

  test('a kit AND --clear is refused, never partially honored', async () => {
    const { code, stdout } = await runCli(['canvas', 'brand', CVS, BK, '--clear']);
    expect(code).toBe(2);
    expect((JSON.parse(stdout) as { error: { code: string } }).error.code).toBe('usage');
  });

  test('neither a kit nor --clear asks which, rather than guessing', async () => {
    const { code, stdout } = await runCli(['canvas', 'brand', CVS]);
    expect(code).toBe(2);
    const error = (JSON.parse(stdout) as { error: Record<string, unknown> }).error;
    expect(String(error.hint)).toContain('moda brand list');
  });
});
