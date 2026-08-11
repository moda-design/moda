/**
 * Agent-protocol wave: `moda describe` (machine-readable verb schema with semantic markers)
 * and `--output FILE` big-result routing on canvas read / task list / web read.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ApiClient } from '../src/api/client.ts';
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

  test('the committed inventory snapshot is the same schema (single source)', async () => {
    const { stdout } = await run(['__inventory']);
    const snapshot = readFileSync(resolve(import.meta.dir, '../verb-inventory.json'), 'utf8');
    expect(JSON.parse(stdout)).toEqual(JSON.parse(snapshot));
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
