import { afterEach, describe, expect, test } from 'bun:test';
import { ApiClient } from '../src/api/client.ts';
import { CliError } from '../src/cliError.ts';

let server: ReturnType<typeof Bun.serve> | undefined;

function serve(handler: (req: Request, hits: number) => Response | Promise<Response>): { base: string } {
  let hits = 0;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => {
      hits += 1;
      return handler(req, hits);
    },
  });
  return { base: `http://127.0.0.1:${server.port}` };
}

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function client(base: string, extra: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}): ApiClient {
  return new ApiClient({
    apiBase: base,
    apiKey: 'moda_live_testkey000000',
    busyBackoffMs: [5, 10, 15],
    sleeper: async () => {},
    env: { MODA_STATE_DIR: '/tmp/moda-client-test-state' },
    ...extra,
  });
}

const BUSY = JSON.stringify({
  error: { type: 'conflict', code: 'canvas_busy', message: 'busy', retry_after_ms: 10 },
});

describe('busy-canvas retry (cli.md §4.2)', () => {
  test('3 retries then success', async () => {
    const { base } = serve((_req, hits) =>
      hits <= 3
        ? new Response(BUSY, { status: 409, headers: { 'Content-Type': 'application/json' } })
        : Response.json({ ok: true, committed: true }),
    );
    const response = await client(base).request({ method: 'POST', path: '/v1/x', body: {} });
    expect(response.status).toBe(200);
  });

  test('exhausted schedule surfaces the conflict (exit-5 lane)', async () => {
    const { base } = serve(() => new Response(BUSY, { status: 409, headers: { 'Content-Type': 'application/json' } }));
    try {
      await client(base).request({ method: 'POST', path: '/v1/x', body: {} });
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.code).toBe('canvas_busy');
      expect((err as CliError).fields.type).toBe('conflict');
    }
  });

  test('--no-retry disables the busy retry', async () => {
    let count = 0;
    const { base } = serve(() => {
      count += 1;
      return new Response(BUSY, { status: 409, headers: { 'Content-Type': 'application/json' } });
    });
    await expect(client(base, { noRetry: true }).request({ method: 'POST', path: '/v1/x', body: {} })).rejects.toThrow();
    expect(count).toBe(1);
  });
});

describe('429 handling', () => {
  test('honors Retry-After then succeeds', async () => {
    const { base } = serve((_req, hits) =>
      hits === 1
        ? new Response(JSON.stringify({ error: { type: 'rate_limited', code: 'rpm', message: 'slow down' } }), {
            status: 429,
            headers: { 'Retry-After': '0', 'Content-Type': 'application/json' },
          })
        : Response.json({ ok: true }),
    );
    const response = await client(base).request({ method: 'GET', path: '/v1/x' });
    expect(response.status).toBe(200);
  });

  test('gives up when waiting would exceed the timeout ceiling', async () => {
    const { base } = serve(
      () =>
        new Response(JSON.stringify({ error: { type: 'rate_limited', code: 'rpm', message: 'slow down' } }), {
          status: 429,
          headers: { 'Retry-After': '3600', 'Content-Type': 'application/json' },
        }),
    );
    try {
      await client(base).request({ method: 'GET', path: '/v1/x', timeoutMs: 1_000 });
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.type).toBe('rate_limited');
    }
  });
});

describe('transport/5xx retry', () => {
  test('2 retries on 5xx then success', async () => {
    const { base } = serve((_req, hits) =>
      hits <= 2 ? new Response('oops', { status: 502 }) : Response.json({ ok: true }),
    );
    const response = await client(base).request({ method: 'GET', path: '/v1/x' });
    expect(response.status).toBe(200);
  });

  test('persistent 5xx surfaces upstream_error (exit-7 lane)', async () => {
    const { base } = serve(
      () =>
        new Response(JSON.stringify({ error: { type: 'upstream_error', code: 'boom', message: 'down' } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    try {
      await client(base).request({ method: 'GET', path: '/v1/x' });
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.type).toBe('upstream_error');
    }
  });

  test('connection failure after retries → transport error', async () => {
    const c = new ApiClient({
      apiBase: 'http://127.0.0.1:1',
      transportRetries: 1,
      sleeper: async () => {},
      env: { MODA_STATE_DIR: '/tmp/moda-client-test-state' },
    });
    try {
      await c.request({ method: 'GET', path: '/v1/x', timeoutMs: 2_000 });
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.source).toBe('transport');
    }
  });
});

describe('headers', () => {
  test('sends auth, version pin, CLI version, user-agent, and a stable Idempotency-Key', async () => {
    const seen: Record<string, string>[] = [];
    const { base } = serve((req) => {
      seen.push(Object.fromEntries(req.headers.entries()));
      return Response.json({ ok: true });
    });
    const idempotency = {
      command: 'canvas edit',
      canvas: 'cvs_X',
      expectedRevision: 'crdt-1',
      payload: '{"a":1}',
    };
    await client(base).request({ method: 'POST', path: '/v1/x', body: { a: 1 }, idempotency });
    await client(base).request({ method: 'POST', path: '/v1/x', body: { a: 1 }, idempotency });
    expect(seen).toHaveLength(2);
    const [first, second] = seen as [Record<string, string>, Record<string, string>];
    expect(first.authorization).toBe('Bearer moda_live_testkey000000');
    expect(first['moda-version']).toBe('2026-05-01');
    expect(first['moda-cli-version']).toBeDefined();
    expect(first['user-agent']).toContain('moda-cli/');
    expect(first['idempotency-key']).toMatch(/^ik_[0-9a-f]{64}$/);
    expect(second['idempotency-key']).toBe(first['idempotency-key']);
  });

  test('records CLI version headers off responses', async () => {
    const stateDir = `/tmp/moda-client-headers-${Date.now()}`;
    const { base } = serve(() =>
      Response.json({ ok: true }, { headers: { 'X-Moda-CLI-Latest': '3.2.1', 'X-Moda-CLI-Minimum-Supported': '0.0.5' } }),
    );
    const c = new ApiClient({ apiBase: base, env: { MODA_STATE_DIR: stateDir } });
    await c.request({ method: 'GET', path: '/v1/x' });
    const stamp = JSON.parse(await Bun.file(`${stateDir}/update-stamp.json`).text()) as Record<string, string>;
    expect(stamp.latest).toBe('3.2.1');
    expect(stamp.minimum_supported).toBe('0.0.5');
  });
});
