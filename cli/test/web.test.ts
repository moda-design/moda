/**
 * `moda web` unit lane: the HTTP layer is a local mock server (client.test.ts pattern) and the
 * command logic is exercised through the exported perform* helpers. Locks the binding backend
 * contract: POST /v1/web/search {query, num_results, include_text} and POST /v1/web/read {url},
 * both returning the metered usage receipt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ApiClient } from '../src/api/client.ts';
import { CliError } from '../src/cliError.ts';
import { MAX_SEARCH_RESULTS, parseResultsCount, performWebRead, performWebSearch } from '../src/commands/web.ts';

let server: ReturnType<typeof Bun.serve> | undefined;

interface Captured {
  path: string;
  body: Record<string, unknown>;
  headers: Headers;
}

function serve(respond: (req: Request, body: Record<string, unknown>) => Response | Promise<Response>): {
  base: string;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      calls.push({ path: new URL(req.url).pathname, body, headers: req.headers });
      return respond(req, body);
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
    env: { MODA_STATE_DIR: '/tmp/moda-web-test-state' },
  });
}

const RECEIPT = { class: 'metered', operation: 'web.search', metered_credits: 1 };

function humanLines(outcome: { human?: (write: (line: string) => void) => void }): string[] {
  const lines: string[] = [];
  outcome.human?.((line) => lines.push(line));
  return lines;
}

describe('parseResultsCount (--results validation)', () => {
  test('accepts 1 through the max', () => {
    expect(parseResultsCount('1')).toBe(1);
    expect(parseResultsCount(String(MAX_SEARCH_RESULTS))).toBe(MAX_SEARCH_RESULTS);
  });

  test('rejects 0, over-max, negatives, and non-integers as usage errors', () => {
    for (const bad of ['0', '11', '-3', '2.5', 'five', '']) {
      expect(() => parseResultsCount(bad)).toThrow(CliError);
    }
    try {
      parseResultsCount('11');
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.code).toBe('usage');
    }
  });
});

describe('web search (POST /v1/web/search)', () => {
  test('minimal call: query plus the injected idempotency_key — server defaults apply otherwise', async () => {
    const { base, calls } = serve(() =>
      Response.json({ results: [{ url: 'https://a.example', title: 'A', snippet: 'alpha' }], usage: RECEIPT }),
    );
    const outcome = await performWebSearch(client(base), { query: 'moda page hosting' });
    expect(calls[0]?.path).toBe('/v1/web/search');
    expect(calls[0]?.body.query).toBe('moda page hosting');
    expect(Object.keys(calls[0]?.body ?? {}).sort()).toEqual(['idempotency_key', 'query']);
    const body = outcome.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.operation).toBe('web.search');
    expect(body.metered).toBe(true);
    expect(body.usage).toEqual(RECEIPT);
    const meta = body.meta as Record<string, unknown>;
    // Meta strip: versions live in `moda version`/doctor; duration_ms stays as the latency instrument.
    expect(meta.cli_version).toBeUndefined();
    expect(typeof meta.duration_ms).toBe('number');
    expect(outcome.exitCode).toBe(0);
  });

  test('--results and --full-text travel as num_results / include_text', async () => {
    const { base, calls } = serve(() => Response.json({ results: [], usage: RECEIPT }));
    await performWebSearch(client(base), { query: 'q', results: 10, fullText: true });
    const body = calls[0]?.body ?? {};
    expect(body.num_results).toBe(10);
    expect(body.include_text).toBe(true);
    expect(Object.keys(body).sort()).toEqual(['idempotency_key', 'include_text', 'num_results', 'query']);
  });

  test('a transport-retried metered POST replays the SAME idempotency key (no re-bill)', async () => {
    const { base, calls } = serve(() =>
      calls.length <= 1
        ? new Response(
            JSON.stringify({ error: { type: 'upstream_error', code: 'upstream_error', message: 'transient' } }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          )
        : Response.json({ results: [], usage: RECEIPT }),
    );
    await performWebSearch(client(base), { query: 'q' });
    expect(calls.length).toBe(2);
    expect(typeof calls[0]?.body.idempotency_key).toBe('string');
    expect(calls[1]?.body.idempotency_key).toBe(calls[0]?.body.idempotency_key as string);
    expect(calls[1]?.headers.get('Idempotency-Key')).toBe(calls[0]?.headers.get('Idempotency-Key') as string);
  });

  test('keyed replay is announced as not re-billed (search and read)', async () => {
    const { base } = serve((req) =>
      new URL(req.url).pathname === '/v1/web/search'
        ? Response.json({ results: [], usage: RECEIPT, replayed: true })
        : Response.json({ url: 'https://example.com', content_markdown: '# x', usage: RECEIPT, replayed: true }),
    );
    const replayLine = '(replayed — served from a previous identical call, not re-billed)';
    expect(humanLines(await performWebSearch(client(base), { query: 'q' }))[1]).toBe(replayLine);
    expect(humanLines(await performWebRead(client(base), 'https://example.com'))[1]).toBe(replayLine);
  });

  test('empty query is a local usage error — no request is made', async () => {
    const { base, calls } = serve(() => Response.json({ results: [] }));
    await expect(performWebSearch(client(base), { query: '   ' })).rejects.toThrow(CliError);
    expect(calls.length).toBe(0);
  });

  test('human output lists results with title, url, snippet, published_at', async () => {
    const { base } = serve(() =>
      Response.json({
        results: [
          { url: 'https://a.example', title: 'Alpha', snippet: 'first  hit', published_at: '2026-08-01' },
          { url: 'https://b.example', title: 'Beta', snippet: 'second hit', text: 'full text here' },
        ],
        usage: RECEIPT,
      }),
    );
    const lines = humanLines(await performWebSearch(client(base), { query: 'q', fullText: true }));
    expect(lines[0]).toBe('web.search: 2 results for "q" (metered)');
    expect(lines[1]).toBe('1. Alpha — https://a.example (2026-08-01)');
    expect(lines[2]).toBe('   first hit');
    // The hint must point at THIS response, never suggest a paid re-run.
    expect(lines.join('\n')).toContain('full text captured in this response: 14 chars');
    expect(lines.join('\n')).not.toContain('full text here');
  });

  test('typed server errors pass through with hint (billing precheck shape)', async () => {
    const { base } = serve(
      () =>
        new Response(
          JSON.stringify({
            error: { type: 'billing', code: 'insufficient_credits', message: 'Not enough credits.' },
          }),
          { status: 402, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    try {
      await performWebSearch(client(base), { query: 'q' });
      expect.unreachable();
    } catch (err) {
      const fields = (err as CliError).fields;
      expect(fields.type).toBe('billing');
      expect(fields.code).toBe('insufficient_credits');
      expect(fields.message).toBe('Not enough credits.');
      expect(fields.source).toBe('api');
      expect(fields.status).toBe(402);
    }
  });
});

describe('web read (POST /v1/web/read)', () => {
  test('sends {url} and passes the contract body through with the receipt', async () => {
    const { base, calls } = serve(() =>
      Response.json({
        url: 'https://example.com/post',
        title: 'A Post',
        content_markdown: '# A Post\n\nBody text.',
        links: ['https://example.com/next'],
        usage: { class: 'metered', operation: 'web.read' },
      }),
    );
    const outcome = await performWebRead(client(base), 'https://example.com/post');
    expect(calls[0]?.path).toBe('/v1/web/read');
    expect(calls[0]?.body.url).toBe('https://example.com/post');
    expect(Object.keys(calls[0]?.body ?? {}).sort()).toEqual(['idempotency_key', 'url']);
    const body = outcome.body as Record<string, unknown>;
    expect(body.operation).toBe('web.read');
    expect(body.metered).toBe(true);
    expect(body.content_markdown).toBe('# A Post\n\nBody text.');
    expect(body.links).toEqual(['https://example.com/next']);
    expect((body.usage as Record<string, unknown>).class).toBe('metered');
  });

  test('human output is the receipt line then the markdown', async () => {
    const { base } = serve(() =>
      Response.json({ url: 'https://example.com', title: 'T', content_markdown: '# Heading', usage: RECEIPT }),
    );
    const lines = humanLines(await performWebRead(client(base), 'https://example.com'));
    expect(lines[0]).toBe('web.read: "T" — https://example.com (metered)');
    expect(lines[1]).toBe('# Heading');
  });

  test('non-http(s) input is a local usage error — no request is made', async () => {
    const { base, calls } = serve(() => Response.json({}));
    for (const bad of ['example.com', 'ftp://example.com', 'file:///etc/passwd', '']) {
      await expect(performWebRead(client(base), bad)).rejects.toThrow(CliError);
    }
    expect(calls.length).toBe(0);
  });

  test('502 web_read_failed is terminal: one request, no transport retry, retryable false', async () => {
    const { base, calls } = serve(
      () =>
        new Response(
          JSON.stringify({
            error: { type: 'upstream_error', code: 'web_read_failed', message: 'The page could not be fetched.' },
          }),
          { status: 502, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    try {
      await performWebRead(client(base), 'https://example.com');
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.code).toBe('web_read_failed');
      expect((err as CliError).fields.retryable).toBe(false);
    }
    // Content failure, not a server fault — the client must not have burned transport retries.
    expect(calls.length).toBe(1);
  });

  test('empty content_markdown gets a signal line instead of silence', async () => {
    const { base } = serve(() =>
      Response.json({ url: 'https://example.com', title: 'T', content_markdown: '', links: [], usage: RECEIPT }),
    );
    const lines = humanLines(await performWebRead(client(base), 'https://example.com'));
    expect(lines[1]).toBe('(page had no extractable content)');
  });
});
