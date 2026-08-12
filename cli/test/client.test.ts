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

  test('honors the envelope retry hint on EVERY attempt (soak F-B)', async () => {
    const waits: number[] = [];
    const { base } = serve((_req, hits) =>
      hits <= 2
        ? new Response(
            JSON.stringify({ error: { type: 'rate_limited', code: 'rate_limited', message: 'slow down', retry_after_ms: 45_000 } }),
            { status: 429, headers: { 'Content-Type': 'application/json' } },
          )
        : Response.json({ ok: true }),
    );
    const response = await client(base, {
      sleeper: async (ms) => {
        waits.push(ms);
      },
    }).request({ method: 'GET', path: '/v1/x' });
    expect(response.status).toBe(200);
    expect(waits).toEqual([45_000, 45_000]);
  });

  test('hintless 429s escalate 1s→2s→4s…30s (+0-1s jitter) instead of a flat 1s storm (soak F-B)', async () => {
    let hits = 0;
    const waits: number[] = [];
    const { base } = serve(() => {
      hits += 1;
      // No Retry-After header, no envelope retry_after_ms — the publish site-cap gate's shape.
      return new Response(JSON.stringify({ error: { type: 'rate_limited', code: 'quota_max_published_sites', message: 'limit' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    try {
      await client(base, {
        sleeper: async (ms) => {
          waits.push(ms);
        },
      }).request({ method: 'GET', path: '/v1/x', timeoutMs: 70_000 });
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.type).toBe('rate_limited');
    }
    // Deterministic under jitter: 6 waits max 67s ≤ 70s budget; a 7th (≥30s) always breaches.
    const schedule = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
    expect(waits).toHaveLength(schedule.length);
    for (const [i, base_] of schedule.entries()) {
      expect(waits[i]).toBeGreaterThanOrEqual(base_);
      expect(waits[i]).toBeLessThan(base_ + 1_000);
    }
    expect(hits).toBe(7);
  });

  test('zero and negative hints are floored at 1s — never a full-speed spin', async () => {
    const waits: number[] = [];
    const { base } = serve((_req, hits) => {
      if (hits === 1)
        return new Response(JSON.stringify({ error: { type: 'rate_limited', code: 'rpm', message: 'edge' } }), {
          status: 429,
          headers: { 'Retry-After': '0', 'Content-Type': 'application/json' },
        });
      if (hits === 2)
        return new Response(
          JSON.stringify({ error: { type: 'rate_limited', code: 'rpm', message: 'edge', retry_after_ms: -60_000 } }),
          { status: 429, headers: { 'Content-Type': 'application/json' } },
        );
      if (hits === 3)
        return new Response(
          JSON.stringify({ error: { type: 'rate_limited', code: 'rpm', message: 'edge', retry_after_ms: 0 } }),
          { status: 429, headers: { 'Content-Type': 'application/json' } },
        );
      return Response.json({ ok: true });
    });
    const response = await client(base, {
      sleeper: async (ms) => {
        waits.push(ms);
      },
    }).request({ method: 'GET', path: '/v1/x' });
    expect(response.status).toBe(200);
    expect(waits).toEqual([1_000, 1_000, 1_000]);
  });

  test('hinted 429s advance the hintless escalation counter (no 1s pin under alternation)', async () => {
    const waits: number[] = [];
    const { base } = serve((_req, hits) => {
      if (hits === 1 || hits === 3)
        return new Response(JSON.stringify({ error: { type: 'rate_limited', code: 'rpm', message: 'no hint' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      if (hits === 2)
        return new Response(
          JSON.stringify({ error: { type: 'rate_limited', code: 'rpm', message: 'hinted', retry_after_ms: 5_000 } }),
          { status: 429, headers: { 'Content-Type': 'application/json' } },
        );
      return Response.json({ ok: true });
    });
    const response = await client(base, {
      sleeper: async (ms) => {
        waits.push(ms);
      },
    }).request({ method: 'GET', path: '/v1/x' });
    expect(response.status).toBe(200);
    expect(waits).toHaveLength(3);
    // attempt 0 hintless: 1s + jitter; attempt 1 hinted: exact; attempt 2 hintless: the counter
    // advanced through BOTH prior 429s → 4s + jitter, not a re-pinned 1s.
    expect(waits[0]).toBeGreaterThanOrEqual(1_000);
    expect(waits[0]).toBeLessThan(2_000);
    expect(waits[1]).toBe(5_000);
    expect(waits[2]).toBeGreaterThanOrEqual(4_000);
    expect(waits[2]).toBeLessThan(5_000);
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

  test('injects the derived idempotency_key into the JSON body (the server reads it from the body)', async () => {
    let seenBody: Record<string, unknown> = {};
    const { base } = serve(async (req) => {
      seenBody = (await req.json()) as Record<string, unknown>;
      return Response.json({ ok: true });
    });
    await client(base).request({
      method: 'POST',
      path: '/v1/x',
      body: { a: 1 },
      idempotency: { command: 'canvas edit', canvas: 'cvs_X', expectedRevision: 'crdt-1', payload: '{"a":1}' },
    });
    expect(seenBody.a).toBe(1);
    expect(String(seenBody.idempotency_key)).toMatch(/^ik_[0-9a-f]{64}$/);
  });

  test('Retry-After response header lands on the error as retryAfterS (canvas_busy contract)', async () => {
    const { base } = serve(
      () =>
        new Response(JSON.stringify({ error: { type: 'conflict', code: 'canvas_active_job', message: 'busy' } }), {
          status: 409,
          headers: { 'Retry-After': '10', 'Content-Type': 'application/json' },
        }),
    );
    try {
      await client(base).request({ method: 'GET', path: '/v1/x' });
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.retryAfterS).toBe(10);
    }
  });

  test('records CLI version headers off responses', async () => {
    const stateDir = `/tmp/moda-client-headers-${Date.now()}`;
    const { base } = serve(() =>
      Response.json({ ok: true }, { headers: { 'Moda-Cli-Latest-Version': '3.2.1', 'Moda-Cli-Minimum-Version': '0.0.5' } }),
    );
    const c = new ApiClient({ apiBase: base, env: { MODA_STATE_DIR: stateDir } });
    await c.request({ method: 'GET', path: '/v1/x' });
    const stamp = JSON.parse(await Bun.file(`${stateDir}/update-stamp.json`).text()) as Record<string, string>;
    expect(stamp.latest).toBe('3.2.1');
    expect(stamp.minimum_supported).toBe('0.0.5');
  });
});
