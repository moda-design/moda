/**
 * `moda file` content-verb lane: the unstubbed list/show/download over /v1/drive/files
 * (studio #9354) and folder-placement uploads over the existing /v1/uploads lanes.
 * Locks: the offset list contract (true total), typed metadata rendering, the presigned-URL
 * download flow (API key never sent cross-origin; server filenames reduced to basenames),
 * the files:read re-mint hint, the #9292 bare-404 pre-deploy tolerance on every lane, and
 * the upload folder_id echo-truth degradation.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ApiClient } from '../src/api/client.ts';
import { CliError } from '../src/cliError.ts';
import { buildProgram } from '../src/main.ts';
import { collectVerbs } from '../src/commands/meta.ts';
import { performFileDownload, performFileList, performFileShow } from '../src/commands/file.ts';
import type { Invocation } from '../src/commands/runtime.ts';
import type { CommandOutcome } from '../src/output/emit.ts';

const FLD = 'fld_01HZX9K2ABCDEFGHJKMNPQRSTV';
const CVS = 'cvs_01HZX9K2ABCDEFGHJKMNPQRSTV';
const FILE = 'file_01HZX9K2ABCDEFGHJKMNPQRSTV';
const UUID = '018f3c6e-1234-4abc-9def-00112233aabb';

const MAIN = resolve(import.meta.dir, '../src/main.ts');

const servers: ReturnType<typeof Bun.serve>[] = [];

interface Captured {
  method: string;
  path: string;
  search: string;
  headers: Headers;
  body: Record<string, unknown>;
  /** Multipart fields: string fields verbatim; file parts as {filename, size}. */
  form?: Record<string, unknown>;
}

function serve(respond: (req: Request, url: URL) => Response | Promise<Response>): { base: string; calls: Captured[] } {
  const calls: Captured[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const captured: Captured = { method: req.method, path: url.pathname, search: url.search, headers: req.headers, body: {} };
      if (req.headers.get('content-type')?.includes('multipart/form-data')) {
        const form: Record<string, unknown> = {};
        for (const [key, value] of await req.formData()) {
          form[key] = value instanceof Blob ? { filename: (value as File).name, size: value.size } : value;
        }
        captured.form = form;
      } else {
        captured.body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      }
      calls.push(captured);
      return respond(req, url);
    },
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, calls };
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function client(base: string): ApiClient {
  return new ApiClient({
    apiBase: base,
    apiKey: 'moda_live_testkey000000',
    busyBackoffMs: [5, 10, 15],
    sleeper: async () => {},
    env: { MODA_STATE_DIR: '/tmp/moda-file-test-state' },
  });
}

function fakeInv(base: string, outDir: string): Invocation {
  return {
    flags: { json: true, pretty: false, quiet: true, noInput: true, noRetry: false },
    context: { apiBase: { value: base }, org: { value: undefined }, outputDir: { value: outDir } },
    env: {},
    emitOpts: { json: true, quiet: true },
    note: () => {},
  } as unknown as Invocation;
}

function humanLines(outcome: CommandOutcome): string[] {
  const lines: string[] = [];
  outcome.human?.((line) => lines.push(line));
  return lines;
}

function errorResponse(status: number, error: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } });
}

/** FastAPI's BARE route 404 — no `error` envelope; the CLI must read it as endpoint-missing. */
function bareRoute404(): Response {
  return new Response(JSON.stringify({ detail: 'Not Found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
}

async function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const scratch = mkdtempSync(join(tmpdir(), 'moda-file-cli-'));
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      MODA_NO_UPDATE_CHECK: '1',
      MODA_CONFIG_DIR: join(scratch, 'config'),
      MODA_STATE_DIR: join(scratch, 'state'),
      MODA_API_KEY: 'moda_live_testkey000000',
      ...env,
    },
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

const fileRow = (overrides: Record<string, unknown> = {}) => ({
  id: FILE,
  name: 'brief.pdf',
  folder_id: FLD,
  visibility: 'team',
  visibility_inherited: true,
  mime_type: 'application/pdf',
  size_bytes: 2048,
  show_in_library: true,
  url: 'https://api.example/proxy/file',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-02T00:00:00Z',
  created_by: { id: UUID, name: 'Jane Doe', email: 'jane@example.com' },
  ...overrides,
});

describe('verb registration + describe schema', () => {
  const verbs = collectVerbs(buildProgram(), '');
  const byName = new Map(verbs.map((verb) => [verb.name, verb]));

  test('the not_available stubs are gone: list/show/download are real reads, upload mutates', () => {
    for (const name of ['file list', 'file show', 'file download']) {
      const verb = byName.get(name);
      expect(verb?.description).not.toContain('not available');
      expect(verb?.markers).toEqual({ mutating: false, destructive: false, metered: false, read_lane: false });
    }
    expect(byName.get('file upload')?.markers.mutating).toBe(true);
    expect(byName.get('file upload')?.markers.metered).toBe(false);
  });

  test('file list carries the offset list-lane flags plus --folder', () => {
    const flags = byName.get('file list')?.flags.map((flag) => flag.flag) ?? [];
    expect(flags).toEqual(expect.arrayContaining(['--folder', '--limit', '--offset', '--all', '--output']));
  });

  test('file upload gains --folder and --name; download keeps -o', () => {
    const upload = byName.get('file upload')?.flags.map((flag) => flag.flag) ?? [];
    expect(upload).toEqual(expect.arrayContaining(['--folder', '--name', '--from-url']));
    expect(byName.get('file download')?.flags.map((flag) => flag.flag)).toContain('--output');
  });

  test('the file content verbs carry the house help epilogue (Examples + Not for)', () => {
    const file = buildProgram().commands.find((cmd) => cmd.name() === 'file');
    for (const name of ['upload', 'list', 'show', 'download']) {
      const leaf = (file?.commands ?? []).find((cmd) => cmd.name() === name);
      let help = '';
      leaf?.configureOutput({ writeOut: (text: string) => (help += text) });
      leaf?.outputHelp();
      expect(help).toContain('Examples:');
      expect(help).toContain('Not for:');
    }
  });
});

describe('file list (GET /v1/drive/files)', () => {
  test('renders id/name/mime/size, surfaces the true-total page note, and keys the payload', async () => {
    const { base, calls } = serve(() =>
      Response.json({ files: [fileRow()], returned: 1, total: 4, limit: 2, offset: 2, has_more: true }),
    );
    const outcome = await performFileList(client(base), { limit: 2, offset: 2 });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.path).toBe('/v1/drive/files');
    expect(calls[0]?.search).toBe('?limit=2&offset=2');
    const lines = humanLines(outcome);
    expect(lines[0]).toBe(`${FILE}  brief.pdf  application/pdf  2048 bytes`);
    expect(lines[1]).toBe('showing 1 of 4 (from offset 2) — more via --offset 3, or --all');
    expect((outcome.body as Record<string, unknown>).operation).toBe('file.list');
  });

  test('a private file is marked; --folder root sends the literal, a folder ref sends the id', async () => {
    const { base, calls } = serve(() =>
      Response.json({ files: [fileRow({ visibility: 'private', visibility_inherited: false })], returned: 1, total: 1 }),
    );
    const outcome = await performFileList(client(base), {}, 'root');
    expect(calls[0]?.search).toBe('?folder_id=root');
    expect(humanLines(outcome)[0]).toContain('(private)');
    await performFileList(client(base), {}, FLD);
    expect(calls[1]?.search).toBe(`?folder_id=${FLD}`);
    // A non-folder ref never reaches the wire.
    await expect(performFileList(client(base), {}, CVS)).rejects.toThrow(CliError);
    expect(calls.length).toBe(2);
  });

  test('empty pages steer at upload (folder-scoped names the folder)', async () => {
    const { base } = serve(() => Response.json({ files: [], returned: 0, total: 0 }));
    expect(humanLines(await performFileList(client(base), {}))[0]).toBe(
      'no files in the drive library yet — add one: moda file upload <path>',
    );
    expect(humanLines(await performFileList(client(base), {}, FLD))[0]).toBe(
      `no files in ${FLD} — upload into it: moda file upload <path> --folder ${FLD}`,
    );
  });

  test('a bare route 404 reads as server-predates, not as a missing resource', async () => {
    const { base } = serve(() => bareRoute404());
    try {
      await performFileList(client(base), {});
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.message).toBe('This server predates the drive file endpoints.');
      expect((err as CliError).fields.hint).toContain('next backend deploy');
    }
  });

  test("an envelope'd folder_not_found passes through untouched (a real missing folder)", async () => {
    const { base } = serve(() =>
      errorResponse(404, { type: 'not_found', code: 'folder_not_found', message: 'Folder not found' }),
    );
    try {
      await performFileList(client(base), {}, FLD);
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.code).toBe('folder_not_found');
      expect((err as CliError).fields.message).toBe('Folder not found');
    }
  });

  test('a missing-scope 403 on the list lane also names the re-mint (shared lane posture)', async () => {
    const { base } = serve(() =>
      errorResponse(403, { type: 'permission', code: 'permission', message: 'API key missing required scope: canvases:read' }),
    );
    try {
      await performFileList(client(base), {});
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.hint).toContain('moda auth login');
    }
  });
});

describe('file show (GET /v1/drive/files/{id})', () => {
  test('renders name, folder, inherited visibility, type, creator, and the download steer', async () => {
    const { base, calls } = serve(() => Response.json({ file: fileRow() }));
    const outcome = await performFileShow(client(base), FILE);
    expect(calls[0]?.path).toBe(`/v1/drive/files/${FILE}`);
    const lines = humanLines(outcome);
    expect(lines[0]).toBe(`brief.pdf  (${FILE})`);
    expect(lines[1]).toBe(`folder: ${FLD}`);
    expect(lines[2]).toBe('visibility: team (inherited from its folder)');
    expect(lines[3]).toBe('type: application/pdf, 2048 bytes');
    expect(lines[4]).toBe('created by Jane Doe 2026-08-01T00:00:00Z; updated 2026-08-02T00:00:00Z');
    expect(lines[5]).toBe(`bytes: moda file download ${FILE}`);
    const body = outcome.body as Record<string, unknown>;
    expect(body.operation).toBe('file.show');
    expect((body.file as Record<string, unknown>).id).toBe(FILE);
  });

  test('unfiled + library-hidden metadata is stated, never dropped', async () => {
    const { base } = serve(() =>
      Response.json({ file: fileRow({ folder_id: null, visibility_inherited: false, show_in_library: false }) }),
    );
    const lines = humanLines(await performFileShow(client(base), FILE));
    expect(lines[1]).toBe('folder: unfiled (library root)');
    expect(lines[2]).toBe('visibility: team — hidden from the library (embedded asset)');
  });

  test('a bare UUID rides the path as given (server back-compat contract)', async () => {
    const { base, calls } = serve(() => Response.json({ file: fileRow({ id: UUID }) }));
    await performFileShow(client(base), UUID);
    expect(calls[0]?.path).toBe(`/v1/drive/files/${UUID}`);
  });

  test('bare 404 → predates; enveloped file_not_found → untouched', async () => {
    const bare = serve(() => bareRoute404());
    await expect(performFileShow(client(bare.base), FILE)).rejects.toThrow('This server predates the drive file endpoints.');
    const typed = serve(() => errorResponse(404, { type: 'not_found', code: 'file_not_found', message: 'File not found' }));
    try {
      await performFileShow(client(typed.base), FILE);
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.code).toBe('file_not_found');
    }
  });

  test('a non-file ref is refused before any request (CLI level)', async () => {
    const { code, stdout } = await runCli(['file', 'show', CVS, '--json', '--api-base', 'http://127.0.0.1:1']);
    expect(code).toBe(2);
    expect(((JSON.parse(stdout) as Record<string, unknown>).error as Record<string, unknown>).code).toBe('usage');
  });
});

describe('file download (GET /v1/drive/files/{id}/download)', () => {
  const BYTES = new TextEncoder().encode('%PDF-1.7 file bytes');

  test('cross-origin presigned URL: bytes fetched WITHOUT the API key, written under the server filename', async () => {
    const signed = serve(() => new Response(BYTES, { headers: { 'Content-Type': 'application/pdf' } }));
    const api = serve(() =>
      Response.json({
        download_url: `${signed.base}/signed/blob`,
        filename: 'brief.pdf',
        mime_type: 'application/pdf',
        size_bytes: BYTES.byteLength,
      }),
    );
    const outDir = mkdtempSync(join(tmpdir(), 'moda-file-dl-'));
    const outcome = await performFileDownload(client(api.base), fakeInv(api.base, outDir), FILE);
    expect(api.calls[0]?.path).toBe(`/v1/drive/files/${FILE}/download`);
    // The signed host is a third party: the API key must never travel there.
    expect(signed.calls[0]?.headers.get('authorization')).toBeNull();
    const outPath = join(outDir, 'brief.pdf');
    expect(readFileSync(outPath, 'utf8')).toBe('%PDF-1.7 file bytes');
    const body = outcome.body as Record<string, unknown>;
    expect(body.operation).toBe('file.download');
    expect(body.output).toBe(outPath);
    expect(body.bytes).toBe(BYTES.byteLength);
    expect(humanLines(outcome)[0]).toBe(`brief.pdf -> ${outPath} (${BYTES.byteLength} bytes)`);
  });

  test('same-origin download_url goes through the authed client; -o wins over the server name', async () => {
    const { base, calls } = serve((_req, url) =>
      url.pathname === '/signed/blob'
        ? new Response(BYTES)
        : Response.json({ download_url: '/signed/blob', filename: 'brief.pdf', size_bytes: BYTES.byteLength }),
    );
    const outDir = mkdtempSync(join(tmpdir(), 'moda-file-dl-'));
    const target = join(outDir, 'renamed.pdf');
    const outcome = await performFileDownload(client(base), fakeInv(base, outDir), FILE, target);
    expect(calls[1]?.path).toBe('/signed/blob');
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer moda_live_testkey000000');
    expect((outcome.body as Record<string, unknown>).output).toBe(target);
    expect(existsSync(target)).toBe(true);
  });

  test('a hostile server filename is reduced to its basename (no path traversal); bare ".." falls back to the ref', async () => {
    const { base } = serve((_req, url) =>
      url.pathname === '/signed/blob'
        ? new Response(BYTES)
        : Response.json({ download_url: '/signed/blob', filename: '../../evil.bin', size_bytes: BYTES.byteLength }),
    );
    const outDir = mkdtempSync(join(tmpdir(), 'moda-file-dl-'));
    const outcome = await performFileDownload(client(base), fakeInv(base, outDir), FILE);
    expect((outcome.body as Record<string, unknown>).output).toBe(join(outDir, 'evil.bin'));
    // basename('..') === '..' — the parent directory must never become the target.
    const dots = serve((_req, url) =>
      url.pathname === '/signed/blob'
        ? new Response(BYTES)
        : Response.json({ download_url: '/signed/blob', filename: '..', size_bytes: BYTES.byteLength }),
    );
    const dotsOut = await performFileDownload(client(dots.base), fakeInv(dots.base, outDir), FILE);
    expect((dotsOut.body as Record<string, unknown>).output).toBe(join(outDir, FILE));
  });

  test('a protocol-relative download_url (//host/…) is judged by its REAL origin — no API key sent', async () => {
    const signed = serve(() => new Response(BYTES));
    const signedHost = signed.base.replace(/^http:/, '');
    const api = serve(() =>
      Response.json({ download_url: signedHost + '/signed/blob', filename: 'brief.pdf', size_bytes: BYTES.byteLength }),
    );
    const outDir = mkdtempSync(join(tmpdir(), 'moda-file-dl-'));
    await performFileDownload(client(api.base), fakeInv(api.base, outDir), FILE);
    expect(signed.calls.length).toBe(1);
    expect(signed.calls[0]?.headers.get('authorization')).toBeNull();
  });

  test('-o - delivers EVERY byte through a pipe (the stdout drain is awaited before exit)', async () => {
    const BIG = 'A'.repeat(3_000_000);
    const { base } = serve((_req, url) =>
      url.pathname === '/signed/blob'
        ? new Response(BIG)
        : Response.json({ download_url: '/signed/blob', filename: 'big.txt', size_bytes: BIG.length }),
    );
    const { code, stdout, stderr } = await runCli(['file', 'download', FILE, '-o', '-'], { MODA_API_BASE: base });
    expect(code).toBe(0);
    // The whole point of '-': the bytes, all of them, and nothing else on stdout.
    expect(stdout.length).toBe(BIG.length);
    expect(stderr).toContain('big.txt -> (stdout)');
  });

  test('a size mismatch against the declared size_bytes is surfaced as a warning', async () => {
    const { base } = serve((_req, url) =>
      url.pathname === '/signed/blob'
        ? new Response(BYTES)
        : Response.json({ download_url: '/signed/blob', filename: 'brief.pdf', size_bytes: BYTES.byteLength + 5 }),
    );
    const outDir = mkdtempSync(join(tmpdir(), 'moda-file-dl-'));
    const lines = humanLines(await performFileDownload(client(base), fakeInv(base, outDir), FILE));
    expect(lines[1]).toContain('warning: the server reported');
  });

  test('the missing files:read scope names the re-mint (moda auth login), not a dead end', async () => {
    const { base } = serve(() =>
      errorResponse(403, {
        type: 'permission',
        code: 'permission',
        message: 'API key missing required scope: files:read',
      }),
    );
    const outDir = mkdtempSync(join(tmpdir(), 'moda-file-dl-'));
    try {
      await performFileDownload(client(base), fakeInv(base, outDir), FILE);
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.code).toBe('permission');
      expect((err as CliError).fields.hint).toContain('files:read');
      expect((err as CliError).fields.hint).toContain('moda auth login');
    }
  });

  test('bare 404 → predates the endpoint; no download_url in a 200 → typed download_failed', async () => {
    const bare = serve(() => bareRoute404());
    const outDir = mkdtempSync(join(tmpdir(), 'moda-file-dl-'));
    await expect(performFileDownload(client(bare.base), fakeInv(bare.base, outDir), FILE)).rejects.toThrow(
      'This server predates the drive file endpoints.',
    );
    const empty = serve(() => Response.json({ filename: 'brief.pdf' }));
    try {
      await performFileDownload(client(empty.base), fakeInv(empty.base, outDir), FILE);
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.code).toBe('download_failed');
    }
  });
});

describe('file upload folder placement (POST /v1/uploads*)', () => {
  const uploadResponse = (overrides: Record<string, unknown> = {}) => ({
    id: FILE,
    url: 'https://api.example/proxy/file',
    filename: 'brief.pdf',
    mime_type: 'application/pdf',
    size_bytes: 11,
    was_duplicate: false,
    folder_id: FLD,
    ...overrides,
  });

  function tempFile(name = 'brief.pdf'): string {
    const dir = mkdtempSync(join(tmpdir(), 'moda-file-up-'));
    const path = join(dir, name);
    writeFileSync(path, 'PDF-CONTENT');
    return path;
  }

  test('--folder rides the multipart form as folder_id and the landing folder is reported', async () => {
    const { base, calls } = serve(() => Response.json(uploadResponse()));
    const path = tempFile();
    const { code, stdout } = await runCli(['file', 'upload', path, '--folder', FLD, '--json'], { MODA_API_BASE: base });
    expect(code).toBe(0);
    expect(calls[0]?.path).toBe('/v1/uploads');
    expect(calls[0]?.form?.folder_id).toBe(FLD);
    expect((calls[0]?.form?.file as Record<string, unknown>).filename).toBe('brief.pdf');
    const body = JSON.parse(stdout) as Record<string, unknown>;
    const uploads = body.uploads as Array<Record<string, unknown>>;
    expect(uploads[0]?.file_id).toBe(FILE);
    expect(uploads[0]?.folder_id).toBe(FLD);
  });

  test('--folder root sends NO folder_id (unfiled is the server default)', async () => {
    const { base, calls } = serve(() => Response.json(uploadResponse({ folder_id: null })));
    const { code } = await runCli(['file', 'upload', tempFile(), '--folder', 'root', '--json'], { MODA_API_BASE: base });
    expect(code).toBe(0);
    expect(calls[0]?.form?.folder_id).toBeUndefined();
  });

  test('echo-truth degradation: a server that ignored folder_id triggers the landed-unfiled warning', async () => {
    const { base } = serve(() => Response.json(uploadResponse({ folder_id: undefined })));
    const { code, stdout } = await runCli(['file', 'upload', tempFile(), '--folder', FLD], { MODA_API_BASE: base });
    expect(code).toBe(0);
    expect(stdout).toContain('predates upload folder placement');
    expect(stdout).toContain(`moda drive move ${FILE} ${FLD}`);
    // The agent lane (--json) carries the same truth: warnings ride the body, not just stdout prose.
    const json = await runCli(['file', 'upload', tempFile(), '--folder', FLD, '--json'], { MODA_API_BASE: base });
    const body = JSON.parse(json.stdout) as Record<string, unknown>;
    expect((body.warnings as string[])[0]).toContain('predates upload folder placement');
  });

  test('--name renames a single multipart upload; two sources refuse --name before the wire', async () => {
    const { base, calls } = serve(() => Response.json(uploadResponse({ filename: 'renamed.pdf' })));
    const { code } = await runCli(['file', 'upload', tempFile(), '--name', 'renamed.pdf', '--json'], { MODA_API_BASE: base });
    expect(code).toBe(0);
    expect((calls[0]?.form?.file as Record<string, unknown>).filename).toBe('renamed.pdf');
    const two = await runCli(['file', 'upload', tempFile(), tempFile('other.pdf'), '--name', 'x.pdf', '--json'], {
      MODA_API_BASE: base,
    });
    expect(two.code).toBe(2);
    expect(calls.length).toBe(1);
  });

  test('--from-url carries folder_id and --name in the JSON body', async () => {
    const { base, calls } = serve(() => Response.json(uploadResponse()));
    const { code, stdout } = await runCli(
      ['file', 'upload', '--from-url', 'https://example.com/a.pdf', '--folder', FLD, '--name', 'brief.pdf', '--json'],
      { MODA_API_BASE: base },
    );
    expect(code).toBe(0);
    expect(calls[0]?.path).toBe('/v1/uploads/from-url');
    expect(calls[0]?.body).toEqual({ source_url: 'https://example.com/a.pdf', filename: 'brief.pdf', folder_id: FLD });
    expect(stdout).toContain(FILE);
  });

  test("from-url on an old server (extra=forbid 422 on folder_id) reads as predates-placement", async () => {
    // The public API's exact RequestValidationError shape: {details: {fields: [{field, code}]}}.
    const { base } = serve(() =>
      errorResponse(422, {
        type: 'unprocessable',
        code: 'validation_failed',
        message: 'Request validation failed',
        details: { fields: [{ field: 'body.folder_id', code: 'extra_forbidden' }] },
      }),
    );
    const { code, stdout } = await runCli(
      ['file', 'upload', '--from-url', 'https://example.com/a.pdf', '--folder', FLD, '--json'],
      { MODA_API_BASE: base },
    );
    expect(code).toBe(2);
    const error = (JSON.parse(stdout) as Record<string, unknown>).error as Record<string, unknown>;
    expect(error.message).toBe('This server predates upload folder placement (--folder).');
    expect(error.hint).toContain('moda drive move');
  });

  test('a NEW server 422 about the folder_id VALUE passes through untouched (not misdiagnosed)', async () => {
    const { base } = serve(() =>
      errorResponse(422, {
        type: 'unprocessable',
        code: 'validation_failed',
        message: 'Request validation failed',
        details: { fields: [{ field: 'body.folder_id', code: 'value_error' }] },
      }),
    );
    const { code, stdout } = await runCli(
      ['file', 'upload', '--from-url', 'https://example.com/a.pdf', '--folder', FLD, '--json'],
      { MODA_API_BASE: base },
    );
    expect(code).toBe(2);
    const error = (JSON.parse(stdout) as Record<string, unknown>).error as Record<string, unknown>;
    expect(error.message).toBe('Request validation failed');
  });

  test('echo EQUALITY: a dedup landing in a different folder warns in the human lane AND the --json body', async () => {
    const OTHER = 'fld_01HZX9K2ZZZZZZZZZZZZZZZZZZ';
    const { base } = serve(() => Response.json(uploadResponse({ folder_id: OTHER, was_duplicate: true })));
    const { code, stdout } = await runCli(['file', 'upload', tempFile(), '--folder', FLD, '--json'], {
      MODA_API_BASE: base,
    });
    expect(code).toBe(0);
    const body = JSON.parse(stdout) as Record<string, unknown>;
    const warnings = body.warnings as string[];
    expect(warnings[0]).toContain(`requested ${FLD} but ${FILE} is in ${OTHER}`);
    expect(warnings[0]).toContain(`moda drive move ${FILE} ${FLD}`);
  });

  test('a non-folder --folder ref is refused before any request', async () => {
    const { base, calls } = serve(() => Response.json(uploadResponse()));
    const { code } = await runCli(['file', 'upload', tempFile(), '--folder', CVS, '--json'], { MODA_API_BASE: base });
    expect(code).toBe(2);
    expect(calls.length).toBe(0);
  });

  test('a dedup hit is said out loud (already existed)', async () => {
    const { base } = serve(() => Response.json(uploadResponse({ was_duplicate: true })));
    const { code, stdout } = await runCli(['file', 'upload', tempFile(), '--folder', FLD], { MODA_API_BASE: base });
    expect(code).toBe(0);
    expect(stdout).toContain('already existed (deduplicated)');
  });
});
