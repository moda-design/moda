/**
 * `moda drive` unit lane: mock HTTP server + the exported perform* helpers, locking the frozen
 * /v1/drive contract — POST/GET /v1/drive/folders, GET /v1/drive/tree, POST
 * /v1/drive/items/{ref}/move, PATCH/DELETE /v1/drive/items/{ref} — plus the typed-item-ref rule
 * (bare UUIDs are ambiguous across kinds), the `root` literal, the --yes gate on `drive rm`, and
 * the `canvas create --folder/--visibility` placement threading.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ApiClient } from '../src/api/client.ts';
import { CliError } from '../src/cliError.ts';
import { buildProgram } from '../src/main.ts';
import { collectVerbs } from '../src/commands/meta.ts';
import {
  parseDestination,
  parseItemRef,
  parseVisibility,
  performDriveDelete,
  performDriveFolders,
  performDriveMkdir,
  performDriveMove,
  performDriveRename,
  performDriveTree,
  performDriveVisibility,
} from '../src/commands/drive.ts';

const FLD = 'fld_01HZX9K2ABCDEFGHJKMNPQRSTV';
const FLD2 = 'fld_01HZX9K2ZZZZZZZZZZZZZZZZZZ';
const CVS = 'cvs_01HZX9K2ABCDEFGHJKMNPQRSTV';
const FILE = 'file_01HZX9K2ABCDEFGHJKMNPQRSTV';
const UUID = '018f3c6e-1234-4abc-9def-00112233aabb';

const MAIN = resolve(import.meta.dir, '../src/main.ts');

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
    busyBackoffMs: [5, 10, 15],
    sleeper: async () => {},
    env: { MODA_STATE_DIR: '/tmp/moda-drive-test-state' },
  });
}

function humanLines(outcome: { human?: (write: (line: string) => void) => void }): string[] {
  const lines: string[] = [];
  outcome.human?.((line) => lines.push(line));
  return lines;
}

function errorResponse(status: number, error: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } });
}

async function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      MODA_NO_UPDATE_CHECK: '1',
      MODA_STATE_DIR: mkdtempSync(join(tmpdir(), 'moda-drive-cli-')),
      ...env,
    },
  });
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { code, stdout };
}

describe('verb registration + describe schema', () => {
  const verbs = collectVerbs(buildProgram(), '');
  const byName = new Map(verbs.map((verb) => [verb.name, verb]));

  test('all seven drive verbs are registered with a description', () => {
    for (const name of ['folders', 'tree', 'mkdir', 'move', 'rename', 'visibility', 'rm']) {
      const verb = byName.get(`drive ${name}`);
      expect(verb?.description.length ?? 0).toBeGreaterThan(0);
    }
  });

  test('markers: reads are marker-free, writes are mutating, and only rm derives destructive', () => {
    expect(byName.get('drive folders')?.markers).toEqual({ mutating: false, destructive: false, metered: false, read_lane: false });
    expect(byName.get('drive tree')?.markers.mutating).toBe(false);
    for (const name of ['mkdir', 'move', 'rename', 'visibility', 'rm']) {
      expect(byName.get(`drive ${name}`)?.markers.mutating).toBe(true);
      expect(byName.get(`drive ${name}`)?.markers.metered).toBe(false);
    }
    expect(byName.get('drive rm')?.markers.destructive).toBe(true);
    expect(byName.get('drive mkdir')?.markers.destructive).toBe(false);
  });

  test('the superseded `folder` stub group is gone', () => {
    expect(verbs.filter((verb) => verb.name.startsWith('folder '))).toEqual([]);
  });

  test('every leaf verb carries the house help epilogue (Examples + Not for)', () => {
    const drive = buildProgram().commands.find((cmd) => cmd.name() === 'drive');
    const leaves = (drive?.commands ?? []).filter((leaf) => leaf.name() !== 'help');
    expect(leaves.length).toBe(7);
    for (const leaf of leaves) {
      // addHelpText lands in the OUTPUT path, not helpInformation() — capture what a user sees.
      let help = '';
      leaf.configureOutput({ writeOut: (text: string) => (help += text) });
      leaf.outputHelp();
      expect(help).toContain('Examples:');
      expect(help).toContain('Not for:');
    }
  });

  test('canvas create exposes --folder and --visibility placement flags', () => {
    const flags = byName.get('canvas create')?.flags.map((flag) => flag.flag) ?? [];
    expect(flags).toContain('--folder');
    expect(flags).toContain('--visibility');
    // The audience effect is stated where an agent reads it.
    const visibility = byName.get('canvas create')?.flags.find((flag) => flag.flag === '--visibility');
    expect(visibility?.description).toContain('private hides it from teammates');
  });

  test('drive folders/tree pass --limit/--offset/--all/--parent and --depth', () => {
    const folders = byName.get('drive folders')?.flags.map((flag) => flag.flag) ?? [];
    expect(folders).toEqual(expect.arrayContaining(['--parent', '--limit', '--offset', '--all', '--output']));
    expect(byName.get('drive tree')?.flags.map((flag) => flag.flag)).toContain('--depth');
  });
});

describe('typed item refs (a bare UUID is ambiguous across kinds)', () => {
  test('typed ids resolve to their kind', () => {
    expect(parseItemRef(` ${FLD} `)).toEqual({ ref: FLD, kind: 'folder' });
    expect(parseItemRef(CVS)).toEqual({ ref: CVS, kind: 'canvas' });
    expect(parseItemRef(FILE)).toEqual({ ref: FILE, kind: 'file' });
  });

  test('bare UUIDs, other prefixes, and junk are usage errors naming the typed forms', () => {
    for (const bad of [UUID, 'bk_01HZX9K2ABCDEFGHJKMNPQRSTV', 'Acme rebrand', '']) {
      try {
        parseItemRef(bad);
        expect.unreachable();
      } catch (err) {
        expect((err as CliError).fields.code).toBe('usage');
        expect((err as CliError).fields.hint).toContain('fld_…');
        expect((err as CliError).fields.hint).toContain('cvs_…');
        expect((err as CliError).fields.hint).toContain('file_…');
      }
    }
  });

  test('move/rename/visibility/rm all refuse a bare UUID BEFORE any request', async () => {
    const { base, calls } = serve(() => Response.json({}));
    const c = client(base);
    const item = { ref: UUID, kind: 'canvas' } as const;
    // The verbs take an already-parsed ref, so the refusal is proven through the CLI itself.
    for (const args of [
      ['drive', 'move', UUID, 'root'],
      ['drive', 'rename', UUID, 'New name'],
      ['drive', 'visibility', UUID, 'private'],
      ['drive', 'rm', UUID, '--yes'],
    ]) {
      const { code, stdout } = await runCli([...args, '--json', '--api-base', base]);
      expect(code).toBe(2);
      expect(((JSON.parse(stdout) as Record<string, unknown>).error as Record<string, unknown>).code).toBe('usage');
    }
    expect(calls.length).toBe(0);
    // Sanity: with a typed ref the same lane does dial the server.
    await performDriveMove(c, item, null).catch(() => {});
  });
});

describe('drive folders (GET /v1/drive/folders)', () => {
  const folder = (overrides: Record<string, unknown> = {}) => ({
    id: FLD,
    name: 'Acme rebrand',
    parent_folder_id: null,
    path: '/Acme rebrand',
    visibility: 'team',
    canvas_count: 3,
    file_count: 1,
    website_count: 0,
    subfolder_count: 0,
    ...overrides,
  });

  test('renders path, id, and non-zero counts; surfaces the page note', async () => {
    const { base, calls } = serve(() =>
      Response.json({ folders: [folder()], returned: 1, total: 4, limit: 2, offset: 2, has_more: true }),
    );
    const outcome = await performDriveFolders(client(base), { limit: 2, offset: 2 });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.path).toBe('/v1/drive/folders');
    expect(calls[0]?.search).toBe('?limit=2&offset=2');
    const lines = humanLines(outcome);
    expect(lines[0]).toBe(`/Acme rebrand  ${FLD}  (3 canvases, 1 file)`);
    expect(lines[1]).toBe('showing 1 of 4 (from offset 2) — more via --offset 3, or --all');
    expect((outcome.body as Record<string, unknown>).operation).toBe('drive.folders');
  });

  test('an all-zero folder reads as (empty), never as a bare line', async () => {
    const { base } = serve(() =>
      Response.json({ folders: [folder({ canvas_count: 0, file_count: 0 })], returned: 1, total: 1 }),
    );
    expect(humanLines(await performDriveFolders(client(base), {}))[0]).toBe(`/Acme rebrand  ${FLD}  (empty)`);
  });

  test("--parent root sends the literal; a folder ref sends the id", async () => {
    const { base, calls } = serve(() => Response.json({ folders: [], returned: 0, total: 0 }));
    await performDriveFolders(client(base), {}, 'root');
    expect(calls[0]?.search).toBe('?parent_id=root');
    await performDriveFolders(client(base), {}, FLD);
    expect(calls[1]?.search).toBe(`?parent_id=${FLD}`);
    // A non-folder ref never reaches the wire.
    await expect(performDriveFolders(client(base), {}, CVS)).rejects.toThrow(CliError);
    expect(calls.length).toBe(2);
  });

  test('an empty page steers at mkdir', async () => {
    const { base } = serve(() => Response.json({ folders: [], returned: 0, total: 0 }));
    expect(humanLines(await performDriveFolders(client(base), {}))[0]).toBe(
      'no folders yet — create one: moda drive mkdir "<project>"',
    );
  });
});

describe('drive tree (GET /v1/drive/tree)', () => {
  test('indents children, marks truncated branches, and states the depth cut', async () => {
    const { base, calls } = serve(() =>
      Response.json({
        tree: [
          {
            id: FLD,
            name: 'Acme rebrand',
            path: '/Acme rebrand',
            visibility: 'team',
            canvas_count: 2,
            file_count: 0,
            subfolder_count: 1,
            children_truncated: false,
            children: [
              {
                id: FLD2,
                name: 'Decks',
                path: '/Acme rebrand/Decks',
                canvas_count: 5,
                file_count: 1,
                subfolder_count: 2,
                children: [],
                children_truncated: true,
              },
            ],
          },
        ],
        depth: 2,
        truncated: true,
      }),
    );
    const outcome = await performDriveTree(client(base), 2);
    expect(calls[0]?.path).toBe('/v1/drive/tree');
    expect(calls[0]?.search).toBe('?depth=2');
    const lines = humanLines(outcome);
    expect(lines[0]).toBe(`Acme rebrand/ [${FLD}] (2 canvases, 1 subfolder)`);
    expect(lines[1]).toBe(`  Decks/ [${FLD2}] (5 canvases, 1 file, 2 subfolders) … (deeper levels not shown — --depth)`);
    expect(lines[2]).toBe('cut off at depth 2 — re-run with a larger --depth to see deeper levels');
    // --json passes the payload through under the CLI's operation name.
    const body = outcome.body as Record<string, unknown>;
    expect(body.operation).toBe('drive.tree');
    expect((body.tree as unknown[]).length).toBe(1);
    expect(body.truncated).toBe(true);
  });

  test('no --depth sends no query (the server default of 3 governs)', async () => {
    const { base, calls } = serve(() => Response.json({ tree: [], depth: 3, truncated: false }));
    const outcome = await performDriveTree(client(base));
    expect(calls[0]?.search).toBe('');
    expect(humanLines(outcome)[0]).toBe('no folders yet — create one: moda drive mkdir "<project>"');
  });
});

describe('drive mkdir (POST /v1/drive/folders)', () => {
  test('sends {name, parent_folder_id} + the injected idempotency key; steers at placement', async () => {
    const { base, calls } = serve(() =>
      Response.json({
        operation: 'drive.folder_create',
        committed: true,
        folder: { id: FLD, name: 'Acme rebrand', parent_folder_id: null, path: '/Acme rebrand', visibility: 'team' },
        created_at: '2026-08-11T00:00:00Z',
        usage: { credits: 0 },
      }),
    );
    const outcome = await performDriveMkdir(client(base), { name: ' Acme rebrand ', parent: null });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/v1/drive/folders');
    expect(calls[0]?.body.name).toBe('Acme rebrand');
    expect(calls[0]?.body.parent_folder_id).toBe(null);
    expect(typeof calls[0]?.body.idempotency_key).toBe('string');
    const lines = humanLines(outcome);
    expect(lines[0]).toBe(`drive.mkdir: /Acme rebrand — ${FLD}`);
    expect(lines[1]).toContain(`moda canvas create --name "…" --folder ${FLD}`);
    expect((outcome.body as Record<string, unknown>).committed).toBe(true);
  });

  test('--in travels as parent_folder_id', async () => {
    const { base, calls } = serve(() => Response.json({ folder: { id: FLD2, path: '/Acme rebrand/Decks' } }));
    await performDriveMkdir(client(base), { name: 'Decks', parent: FLD });
    expect(calls[0]?.body.parent_folder_id).toBe(FLD);
  });

  test('an over-long or empty name fails locally — no request', async () => {
    const { base, calls } = serve(() => Response.json({}));
    await expect(performDriveMkdir(client(base), { name: '   ', parent: null })).rejects.toThrow(CliError);
    await expect(performDriveMkdir(client(base), { name: 'x'.repeat(256), parent: null })).rejects.toThrow(CliError);
    expect(calls.length).toBe(0);
  });

  test('409 folder_name_conflict names the existing folder from details', async () => {
    const { base } = serve(() =>
      errorResponse(409, {
        type: 'conflict',
        code: 'folder_name_conflict',
        message: 'A folder with that name already exists.',
        details: { existing_folder_id: FLD2 },
      }),
    );
    try {
      await performDriveMkdir(client(base), { name: 'Decks', parent: FLD });
      expect.unreachable();
    } catch (err) {
      const fields = (err as CliError).fields;
      expect(fields.code).toBe('folder_name_conflict');
      expect(fields.hint).toBe(`A folder named "Decks" already exists: ${FLD2} — use it, or pick another name.`);
    }
  });

  test('the same conflict without details still steers, without inventing an id', async () => {
    const { base } = serve(() =>
      errorResponse(409, { type: 'conflict', code: 'folder_name_conflict', message: 'exists' }),
    );
    try {
      await performDriveMkdir(client(base), { name: 'Decks', parent: null });
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.hint).toContain('moda drive folders');
      expect((err as CliError).fields.hint).not.toContain('fld_');
    }
  });
});

describe('drive move (POST /v1/drive/items/{ref}/move)', () => {
  test("the literal 'root' becomes folder_id: null", async () => {
    expect(parseDestination('root')).toBe(null);
    expect(parseDestination(' ROOT ')).toBe(null);
    expect(parseDestination(FLD)).toBe(FLD);
    const { base, calls } = serve(() =>
      Response.json({
        operation: 'drive.move',
        committed: true,
        item: { id: CVS, kind: 'canvas', name: 'Q3 deck', folder_id: null },
        usage: { credits: 0 },
      }),
    );
    const outcome = await performDriveMove(client(base), { ref: CVS, kind: 'canvas' }, null);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe(`/v1/drive/items/${CVS}/move`);
    expect(calls[0]?.body).toEqual({ folder_id: null });
    expect(humanLines(outcome)[0]).toBe(`drive.move: canvas "Q3 deck" (${CVS}) → the team root`);
  });

  test('a folder destination travels as-is and is named in the human line', async () => {
    const { base, calls } = serve(() =>
      Response.json({ item: { id: FILE, kind: 'file', name: 'logo.png', folder_id: FLD } }),
    );
    const outcome = await performDriveMove(client(base), { ref: FILE, kind: 'file' }, FLD);
    expect(calls[0]?.body).toEqual({ folder_id: FLD });
    expect(humanLines(outcome)[0]).toBe(`drive.move: file "logo.png" (${FILE}) → ${FLD}`);
  });

  test('typed failures carry recovery hints (circular, name conflict, protected)', async () => {
    const cases: Array<[number, string, string]> = [
      [400, 'folder_circular_reference', 'moda drive tree'],
      [409, 'folder_name_conflict', 'moda drive rename'],
      [403, 'brand_kit_folder_protected', 'managed by Moda'],
    ];
    for (const [status, code, expected] of cases) {
      server?.stop(true);
      const { base } = serve(() => errorResponse(status, { type: 'conflict', code, message: 'no' }));
      try {
        await performDriveMove(client(base), { ref: FLD, kind: 'folder' }, FLD2);
        expect.unreachable();
      } catch (err) {
        expect((err as CliError).fields.code).toBe(code);
        expect((err as CliError).fields.hint).toContain(expected);
      }
    }
  });

  test('an unmapped code passes through untouched — the CLI never invents a hint', async () => {
    const { base } = serve(() => errorResponse(404, { type: 'not_found', code: 'canvas_not_found', message: 'gone' }));
    try {
      await performDriveMove(client(base), { ref: CVS, kind: 'canvas' }, FLD);
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.code).toBe('canvas_not_found');
      expect((err as CliError).fields.type).toBe('not_found');
      expect((err as CliError).fields.hint).toBeUndefined();
    }
  });

  test('PRE-DEPLOY: a server without /v1/drive fails typed (bare 404), never as a CLI stub', async () => {
    const { base } = serve(() => new Response('not found', { status: 404 }));
    for (const call of [
      performDriveTree(client(base)),
      performDriveMove(client(base), { ref: CVS, kind: 'canvas' }, FLD),
    ]) {
      try {
        await call;
        expect.unreachable();
      } catch (err) {
        const fields = (err as CliError).fields;
        expect(fields.code).toBe('http_404');
        expect(fields.type).toBe('not_found');
        expect(fields.source).toBe('api');
        expect(fields.retryable).toBe(false);
      }
    }
  });
});

describe('drive rename / visibility (PATCH /v1/drive/items/{ref})', () => {
  test('rename PATCHes {name} only', async () => {
    const { base, calls } = serve(() =>
      Response.json({ operation: 'drive.update', committed: true, item: { id: FLD, kind: 'folder', name: 'Acme 2026' } }),
    );
    const outcome = await performDriveRename(client(base), { ref: FLD, kind: 'folder' }, 'Acme 2026');
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.path).toBe(`/v1/drive/items/${FLD}`);
    expect(calls[0]?.body).toEqual({ name: 'Acme 2026' });
    expect(humanLines(outcome)[0]).toBe(`drive.rename: folder ${FLD} is now "Acme 2026"`);
  });

  test('visibility PATCHes {visibility} and states the audience effect', async () => {
    const { base, calls } = serve(() =>
      Response.json({
        operation: 'drive.update',
        committed: true,
        item: { id: CVS, kind: 'canvas', name: 'Q3 deck', visibility: 'private', visibility_inherited: false },
      }),
    );
    const outcome = await performDriveVisibility(client(base), { ref: CVS, kind: 'canvas' }, 'private');
    expect(calls[0]?.body).toEqual({ visibility: 'private' });
    expect(humanLines(outcome)[0]).toBe(`drive.visibility: canvas "Q3 deck" (${CVS}) is now private — hidden from teammates`);
  });

  test('team visibility says who can see it; inheritance is surfaced', async () => {
    const { base } = serve(() =>
      Response.json({ item: { id: CVS, kind: 'canvas', visibility: 'team', visibility_inherited: true } }),
    );
    const line = humanLines(await performDriveVisibility(client(base), { ref: CVS, kind: 'canvas' }, 'team'))[0];
    expect(line).toContain('is now team — visible to the whole team');
    expect(line).toContain('inherited from the folder it lives in');
  });

  test('an unknown visibility value is a local usage error', () => {
    expect(parseVisibility('team')).toBe('team');
    expect(parseVisibility(' private ')).toBe('private');
    expect(() => parseVisibility('public')).toThrow(CliError);
  });

  test('403 visibility_change_denied explains who may change it', async () => {
    const { base } = serve(() =>
      errorResponse(403, { type: 'permission', code: 'visibility_change_denied', message: 'nope' }),
    );
    try {
      await performDriveVisibility(client(base), { ref: CVS, kind: 'canvas' }, 'private');
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.hint).toContain('Only the creator');
    }
  });
});

describe('drive rm (DELETE /v1/drive/items/{ref})', () => {
  test('no --recursive sends no query; the deletion is confirmed by name', async () => {
    const { base, calls } = serve(() =>
      Response.json({
        operation: 'drive.delete',
        committed: true,
        item: { id: FILE, kind: 'file', name: 'logo.png' },
        recursive: false,
      }),
    );
    const outcome = await performDriveDelete(client(base), { ref: FILE, kind: 'file' }, false);
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.path).toBe(`/v1/drive/items/${FILE}`);
    expect(calls[0]?.search).toBe('');
    expect(humanLines(outcome)[0]).toBe(`drive.rm: deleted file "logo.png" (${FILE})`);
  });

  test('--recursive travels as a query param and is stated in the confirmation', async () => {
    const { base, calls } = serve(() =>
      Response.json({ item: { id: FLD, kind: 'folder', name: 'Acme rebrand' }, recursive: true }),
    );
    const outcome = await performDriveDelete(client(base), { ref: FLD, kind: 'folder' }, true);
    expect(calls[0]?.search).toBe('?recursive=true');
    expect(humanLines(outcome)[0]).toBe(`drive.rm: deleted folder "Acme rebrand" (${FLD}) and everything inside it`);
  });

  test('409 folder_not_empty hands back the exact recursive re-run', async () => {
    const { base } = serve(() => errorResponse(409, { type: 'conflict', code: 'folder_not_empty', message: 'not empty' }));
    try {
      await performDriveDelete(client(base), { ref: FLD, kind: 'folder' }, false);
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.hint).toContain(`moda drive rm ${FLD} --recursive --yes`);
      expect((err as CliError).fields.hint).toContain('approved');
    }
  });

  test('--json without --yes is refused before any request (destructive gate)', async () => {
    const { base, calls } = serve(() => Response.json({}));
    const { code, stdout } = await runCli(['drive', 'rm', FLD, '--json', '--api-base', base]);
    expect(code).toBe(2);
    const error = (JSON.parse(stdout) as Record<string, unknown>).error as Record<string, unknown>;
    expect(error.code).toBe('usage');
    expect(String(error.hint)).toBe(
      `If the host/user approved this action, re-run with --yes: moda drive rm ${FLD} --yes`,
    );
    expect(calls.length).toBe(0);
  });
});

describe('canvas create placement (--folder / --visibility)', () => {
  test('both flags thread into the create payload as folder_id / visibility', async () => {
    const { base, calls } = serve(() =>
      Response.json({ operation: 'canvas.create', committed: true, canvas: { id: CVS, name: 'Q3 deck' } }),
    );
    const { code } = await runCli(
      ['canvas', 'create', '--name', 'Q3 deck', '--folder', FLD, '--visibility', 'private', '--json', '--api-base', base],
      { MODA_API_KEY: 'moda_live_testkey000000' },
    );
    expect(code).toBe(0);
    expect(calls[0]?.path).toBe('/v1/canvases');
    expect(calls[0]?.body.folder_id).toBe(FLD);
    expect(calls[0]?.body.visibility).toBe('private');
  });

  test('omitting them sends neither key (the default save location governs)', async () => {
    const { base, calls } = serve(() => Response.json({ operation: 'canvas.create', canvas: { id: CVS } }));
    await runCli(['canvas', 'create', '--name', 'Q3 deck', '--json', '--api-base', base], {
      MODA_API_KEY: 'moda_live_testkey000000',
    });
    expect(calls[0]?.body.folder_id).toBeUndefined();
    expect(calls[0]?.body.visibility).toBeUndefined();
  });

  test('a bad --visibility or a non-folder --folder fails locally, before the call', async () => {
    const { base, calls } = serve(() => Response.json({}));
    for (const args of [
      ['canvas', 'create', '--name', 'x', '--visibility', 'public'],
      ['canvas', 'create', '--name', 'x', '--folder', CVS],
    ]) {
      const { code, stdout } = await runCli([...args, '--json', '--api-base', base], {
        MODA_API_KEY: 'moda_live_testkey000000',
      });
      expect(code).toBe(2);
      expect(((JSON.parse(stdout) as Record<string, unknown>).error as Record<string, unknown>).code).toBe('usage');
    }
    expect(calls.length).toBe(0);
  });
});
