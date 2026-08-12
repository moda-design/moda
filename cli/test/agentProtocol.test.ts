/**
 * Agent-protocol wave: `moda describe` (machine-readable verb schema with semantic markers)
 * and `--output FILE` big-result routing on canvas read / task list / web read.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ApiClient } from '../src/api/client.ts';
import { CliError } from '../src/cliError.ts';
import { performWebRead } from '../src/commands/web.ts';
import { PREVIEW_CHARS } from '../src/output/resultFile.ts';

const MAIN = resolve(import.meta.dir, '../src/main.ts');

let server: ReturnType<typeof Bun.serve> | undefined;

function serve(handler: (req: Request) => Response | Promise<Response>): { base: string } {
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  return { base: `http://127.0.0.1:${server.port}` };
}

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

async function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string }> {
  const scratch = mkdtempSync(join(tmpdir(), 'moda-proto-'));
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      MODA_NO_UPDATE_CHECK: '1',
      MODA_CONFIG_DIR: join(scratch, 'config'),
      MODA_STATE_DIR: join(scratch, 'state'),
      ...env,
    },
  });
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { code, stdout };
}

describe('moda describe (machine-readable schema)', () => {
  test('single verb: full schema with positionals, typed flags, and markers', async () => {
    const { code, stdout } = await run(['describe', 'canvas', 'read', '--json']);
    expect(code).toBe(0);
    const verb = (JSON.parse(stdout) as Record<string, unknown>).verb as Record<string, unknown>;
    expect(verb.name).toBe('canvas read');
    expect(verb.positionals).toEqual([{ name: 'canvas', required: true, variadic: false }]);
    const flags = verb.flags as Array<Record<string, unknown>>;
    const page = flags.find((f) => f.flag === '--page');
    expect(page?.takes_value).toBe(true);
    expect(page?.required).toBe(false);
    expect(verb.markers).toEqual({ mutating: false, destructive: false, metered: false, read_lane: true });
  });

  test('marker truth across lanes: metered, destructive, mutating', async () => {
    const video = await run(['describe', 'media', 'generate-video', '--json']);
    expect(((JSON.parse(video.stdout) as Record<string, unknown>).verb as Record<string, unknown>).markers).toEqual({
      mutating: true,
      destructive: false,
      metered: true,
      read_lane: false,
    });
    const del = await run(['describe', 'site', 'delete', '--json']);
    expect(((JSON.parse(del.stdout) as Record<string, unknown>).verb as Record<string, unknown>).markers).toEqual({
      mutating: true,
      destructive: true,
      metered: false,
      read_lane: false,
    });
  });

  test('bare listing is token-frugal: name + description + markers only, no flags', async () => {
    const { code, stdout } = await run(['describe', '--json']);
    expect(code).toBe(0);
    const verbs = (JSON.parse(stdout) as Record<string, unknown>).verbs as Array<Record<string, unknown>>;
    expect(verbs.length).toBeGreaterThan(50);
    for (const verb of verbs.slice(0, 5)) {
      expect(Object.keys(verb).sort()).toEqual(['description', 'markers', 'name']);
    }
  });

  test('unknown verb fails typed with a near-miss hint', async () => {
    const { code, stdout } = await run(['describe', 'canvas', 'reed', '--json']);
    expect(code).not.toBe(0);
    const body = JSON.parse(stdout) as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).code).toBe('usage');
    expect(String((body.error as Record<string, unknown>).hint)).toContain('canvas read');
  });

  test('dotted verb grammar (gate finding F7): the error names the exact space-separated retry', async () => {
    const { code, stdout } = await run(['describe', 'brand.create', '--json']);
    expect(code).toBe(2);
    const error = (JSON.parse(stdout) as Record<string, unknown>).error as Record<string, unknown>;
    expect(error.code).toBe('usage');
    expect(error.hint).toBe('Verb names are space-separated: moda describe brand create');
  });

  test('unknown verb with no near miss still teaches the grammar', async () => {
    const { code, stdout } = await run(['describe', 'zebra', '--json']);
    expect(code).toBe(2);
    const error = (JSON.parse(stdout) as Record<string, unknown>).error as Record<string, unknown>;
    expect(String(error.hint)).toContain('space-separated');
  });

  test('the committed inventory snapshot is the same schema (single source)', async () => {
    const { stdout } = await run(['__inventory']);
    const snapshot = readFileSync(resolve(import.meta.dir, '../verb-inventory.json'), 'utf8');
    expect(JSON.parse(stdout)).toEqual(JSON.parse(snapshot));
  });
});

describe('commander parse errors become typed envelopes (gate finding F6)', () => {
  test('canvas markup missing --page: typed usage error naming the exact retry shape', async () => {
    const { code, stdout } = await run(['canvas', 'markup', 'cvs_123', '--file', 'page.xml', '--json']);
    expect(code).toBe(2);
    const error = (JSON.parse(stdout) as Record<string, unknown>).error as Record<string, unknown>;
    expect(error.code).toBe('usage');
    expect(String(error.message)).toContain('--page');
    const hint = String(error.hint);
    expect(hint).toContain('moda canvas markup CANVAS --file FILE --page PAGE_ID');
    expect(hint).toContain('moda canvas show');
  });

  test('any other missing required flag gets a typed envelope too — never an empty --json stdout', async () => {
    const { code, stdout } = await run(['canvas', 'markup', 'cvs_123', '--page', 'p_a', '--json']);
    expect(code).toBe(2);
    const error = (JSON.parse(stdout) as Record<string, unknown>).error as Record<string, unknown>;
    expect(error.code).toBe('usage');
    expect(String(error.message)).toContain('--file');
    expect(String(error.hint)).toContain('moda describe canvas markup --json');
  });

  test('a CliError from an option-value parser is a typed envelope, not a stack trace', async () => {
    const { code, stdout } = await run(['template', 'list', '--limit', 'abc', '--json']);
    expect(code).toBe(2);
    const error = (JSON.parse(stdout) as Record<string, unknown>).error as Record<string, unknown>;
    expect(error.code).toBe('usage');
    expect(String(error.message)).toContain("--limit value 'abc'");
  });

  test('with both flags present, a missing markup file surfaces the FILE error (guard ordering pin)', async () => {
    const { code, stdout } = await run([
      'canvas', 'markup', 'cvs_123', '--file', 'definitely-missing.xml', '--page', 'p_a', '--json',
    ]);
    expect(code).not.toBe(0);
    const error = (JSON.parse(stdout) as Record<string, unknown>).error as Record<string, unknown>;
    expect(String(error.message)).toContain('definitely-missing.xml');
  });

  test('bare `moda` still prints usage help on stderr (the non-usage commander lane flushes)', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'moda-proto-'));
    const proc = Bun.spawn(['bun', MAIN], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        MODA_NO_UPDATE_CHECK: '1',
        MODA_CONFIG_DIR: join(scratch, 'config'),
        MODA_STATE_DIR: join(scratch, 'state'),
      },
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(code).toBe(2);
    expect(stderr).toContain('Usage: moda');
  });
});

describe('--output big-result routing', () => {
  test('web read --output: full payload in the file, bounded preview in the envelope', async () => {
    const markdown = `# Title\n${'lorem ipsum '.repeat(300)}`;
    const { base } = serve(() =>
      Response.json({
        url: 'https://example.com',
        title: 'T',
        content_markdown: markdown,
        links: ['https://a', 'https://b'],
        usage: { class: 'metered', operation: 'web.read' },
      }),
    );
    const client = new ApiClient({
      apiBase: base,
      apiKey: 'moda_live_testkey000000',
      sleeper: async () => {},
      env: { MODA_STATE_DIR: '/tmp/moda-proto-web' },
    });
    const out = join(mkdtempSync(join(tmpdir(), 'moda-proto-out-')), 'page.json');
    const outcome = await performWebRead(client, 'https://example.com', { output: out });
    const body = outcome.body as Record<string, unknown>;
    expect(body.output).toBe(out);
    const preview = body.preview as Record<string, unknown>;
    expect(String(preview.content_head).length).toBeLessThanOrEqual(PREVIEW_CHARS + 1);
    expect(preview.links_count).toBe(2);
    expect(body.content_markdown).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    expect(onDisk.content_markdown).toBe(markdown);
    expect((onDisk.usage as Record<string, unknown>).class).toBe('metered');
  });

  test('--output is NOT part of the idempotency key: identical reads replay regardless of path', async () => {
    // Written down as a tested property: the derived key hashes only {url}, so a re-run after a
    // local write failure replays the billed read at no extra charge.
    const bodies: Array<Record<string, unknown>> = [];
    const { base } = serve(async (req) => {
      bodies.push((await req.json()) as Record<string, unknown>);
      return Response.json({ url: 'https://example.com', content_markdown: 'x', links: [], usage: {} });
    });
    const client = new ApiClient({
      apiBase: base,
      apiKey: 'moda_live_testkey000000',
      sleeper: async () => {},
      env: { MODA_STATE_DIR: '/tmp/moda-proto-idem' },
    });
    const dir = mkdtempSync(join(tmpdir(), 'moda-proto-key-'));
    await performWebRead(client, 'https://example.com', { output: join(dir, 'a.json') });
    await performWebRead(client, 'https://example.com', { output: join(dir, 'b.json') });
    await performWebRead(client, 'https://example.com');
    expect(bodies[0]?.idempotency_key).toBeDefined();
    expect(bodies[1]?.idempotency_key).toBe(bodies[0]?.idempotency_key as string);
    expect(bodies[2]?.idempotency_key).toBe(bodies[0]?.idempotency_key as string);
  });

  test('--output files are redacted on disk (signed URLs, keys) — the PR#4 bug-class guard', async () => {
    const { base } = serve(() =>
      Response.json({
        url: 'https://example.com',
        content_markdown: 'key moda_live_deadbeef4321aa and https://cdn.example.com/a.png?Signature=TOPSECRET',
        links: [],
        usage: {},
      }),
    );
    const client = new ApiClient({
      apiBase: base,
      apiKey: 'moda_live_testkey000000',
      sleeper: async () => {},
      env: { MODA_STATE_DIR: '/tmp/moda-proto-redact' },
    });
    const out = join(mkdtempSync(join(tmpdir(), 'moda-proto-redact-')), 'page.json');
    await performWebRead(client, 'https://example.com', { output: out });
    const raw = readFileSync(out, 'utf8');
    expect(raw).not.toContain('moda_live_deadbeef4321aa');
    expect(raw).not.toContain('TOPSECRET');
    expect(raw).toContain('[REDACTED]');
  });

  test('an unwritable --output path fails in the io lane with the billed-replay hint', async () => {
    const { base } = serve(() =>
      Response.json({ url: 'https://example.com', content_markdown: 'x', links: [], usage: {} }),
    );
    const client = new ApiClient({
      apiBase: base,
      apiKey: 'moda_live_testkey000000',
      sleeper: async () => {},
      env: { MODA_STATE_DIR: '/tmp/moda-proto-io' },
    });
    try {
      await performWebRead(client, 'https://example.com', { output: '/proc/1/nope/page.json' });
      expect.unreachable();
    } catch (err) {
      const fields = (err as CliError).fields;
      expect(fields.code).toBe('io_error');
      expect(fields.hint).toContain('no extra charge');
    }
  });

  test('canvas read --output: file parses, envelope carries revision + page preview, no DSL body', async () => {
    const dsl = `<content>${'x'.repeat(2000)}</content> n1 p_a p_b`;
    const { base } = serve((req) =>
      new URL(req.url).pathname.includes('/state')
        ? Response.json({ state: dsl, revision: 'rev_9' })
        : Response.json({}),
    );
    const out = join(mkdtempSync(join(tmpdir(), 'moda-proto-read-')), 'state.json');
    const { code, stdout } = await run(
      ['canvas', 'read', 'cvs_01HZX9K2ABCDEFGHJKMNPQRSTV', '--output', out, '--json'],
      { MODA_API_BASE: base, MODA_API_KEY: 'moda_live_testkey000000' },
    );
    expect(code).toBe(0);
    const body = JSON.parse(stdout) as Record<string, unknown>;
    expect(body.revision).toBe('rev_9');
    expect(body.state).toBeUndefined();
    const preview = body.preview as Record<string, unknown>;
    expect(preview.page_ids).toEqual(['p_a', 'p_b']);
    expect(String(preview.dsl_head).length).toBeLessThanOrEqual(PREVIEW_CHARS + 1);
    expect((JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>).state).toBe(dsl);
  });

  test('canvas read --summary: shipped envelope passthrough + the revision feeds the pin cache', async () => {
    const { base } = serve((req) =>
      new URL(req.url).pathname.endsWith('/state/summary')
        ? Response.json({
            operation: 'canvas.read_summary',
            canvas: { id: 'cvs_01HZX9K2ABCDEFGHJKMNPQRSTV', uuid: '018f3c6e-1234-4abc-9def-00112233aabb' },
            revision: 'rev_42',
            name: 'Q3 deck',
            pages: [
              { id: 'p_a', name: 'Cover', node_count: 9 },
              { id: 'p_b', name: 'Agenda', node_count: 14 },
            ],
            page_count: 2,
            node_total: 23,
            current_page_id: 'p_a',
            usage: { class: 'deterministic', metered_credits: 0 },
            editor_url: 'https://moda.app/c/cvs_01HZX9K2ABCDEFGHJKMNPQRSTV',
          })
        : Response.json({}),
    );
    const scratch = mkdtempSync(join(tmpdir(), 'moda-summary-'));
    const proc = Bun.spawn(
      ['bun', MAIN, 'canvas', 'read', 'cvs_01HZX9K2ABCDEFGHJKMNPQRSTV', '--summary', '--json'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          MODA_NO_UPDATE_CHECK: '1',
          MODA_API_BASE: base,
          MODA_API_KEY: 'moda_live_testkey000000',
          MODA_CONFIG_DIR: join(scratch, 'config'),
          MODA_STATE_DIR: join(scratch, 'state'),
        },
      },
    );
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(code).toBe(0);
    const body = JSON.parse(stdout) as Record<string, unknown>;
    expect(body.operation).toBe('canvas.summary');
    expect(body.page_count).toBe(2);
    expect(body.node_total).toBe(23);
    expect(body.current_page_id).toBe('p_a');
    expect((body.pages as unknown[]).length).toBe(2);
    expect(body.revision).toBe('rev_42');
    // Read-lane proof: the summary's revision landed in the pin cache (keyed by ref AND uuid).
    const revisions = JSON.parse(readFileSync(join(scratch, 'state', 'revisions.json'), 'utf8')) as Record<
      string,
      { revision: string }
    >;
    expect(revisions['cvs_01HZX9K2ABCDEFGHJKMNPQRSTV']?.revision).toBe('rev_42');
  });

  test('canvas read --summary on a pre-summary server fails typed with the steer', async () => {
    const { base } = serve(() => new Response('not found', { status: 404 }));
    const scratch = mkdtempSync(join(tmpdir(), 'moda-summary-404-'));
    const proc = Bun.spawn(
      ['bun', MAIN, 'canvas', 'read', 'cvs_01HZX9K2ABCDEFGHJKMNPQRSTV', '--summary', '--json'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          MODA_NO_UPDATE_CHECK: '1',
          MODA_API_BASE: base,
          MODA_API_KEY: 'moda_live_testkey000000',
          MODA_CONFIG_DIR: join(scratch, 'config'),
          MODA_STATE_DIR: join(scratch, 'state'),
        },
      },
    );
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(code).not.toBe(0);
    const body = JSON.parse(stdout) as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).message).toContain('predates the summary endpoint');
    expect(String((body.error as Record<string, unknown>).hint)).toContain('moda canvas show');
  });

  test('task list --output: returned count + first-N preview, full list on disk', async () => {
    const tasks = Array.from({ length: 7 }, (_, i) => ({ id: `task_${i}`, status: 'succeeded', big: 'z'.repeat(200) }));
    const { base } = serve(() => Response.json({ tasks }));
    const out = join(mkdtempSync(join(tmpdir(), 'moda-proto-tasks-')), 'tasks.json');
    const { code, stdout } = await run(['task', 'list', '--output', out, '--json'], {
      MODA_API_BASE: base,
      MODA_API_KEY: 'moda_live_testkey000000',
    });
    expect(code).toBe(0);
    const body = JSON.parse(stdout) as Record<string, unknown>;
    expect(body.returned).toBe(7);
    expect((body.preview as unknown[]).length).toBe(3);
    expect(body.tasks).toBeUndefined();
    expect(((JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>).tasks as unknown[]).length).toBe(7);
  });
});
