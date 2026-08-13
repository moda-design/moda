/**
 * `moda ask` unit lane: the HTTP layer is a local mock server (client.test.ts pattern) and the
 * command logic is exercised through the exported performAsk helper. Locks the binding backend
 * contract: POST /v1/ask {question, context?} → {answer, citations?, usage: {class: "assisted",
 * metered_credits: 0}} — the free advisory lane — plus the server-predates-endpoint posture.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ApiClient } from '../src/api/client.ts';
import { CliError } from '../src/cliError.ts';
import { buildProgram } from '../src/main.ts';
import { collectVerbs } from '../src/commands/meta.ts';
import { MAX_CONTEXT_CHARS, MAX_QUESTION_CHARS, performAsk, renderEntry } from '../src/commands/ask.ts';

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
    env: { MODA_STATE_DIR: '/tmp/moda-ask-test-state' },
  });
}

/** The memo's honest free sub-class: a model ran, zero credits spent. */
const RECEIPT = { class: 'assisted', metered_credits: 0 };

function humanLines(outcome: { human?: (write: (line: string) => void) => void }): string[] {
  const lines: string[] = [];
  outcome.human?.((line) => lines.push(line));
  return lines;
}

describe('ask (POST /v1/ask)', () => {
  test('minimal call: exactly {question} on the wire; envelope passes through with the assisted receipt', async () => {
    const { base, calls } = serve(() =>
      Response.json({
        answer: 'Use `moda canvas markup` for the first page.',
        citations: [{ verb: 'canvas markup', reference: 'markup.md' }],
        usage: RECEIPT,
      }),
    );
    const outcome = await performAsk(client(base), { question: 'how do I create a page?' });
    expect(calls[0]?.path).toBe('/v1/ask');
    expect(calls[0]?.body.question).toBe('how do I create a page?');
    // Free lane: no injected idempotency key — nothing to re-bill on a transport retry.
    expect(Object.keys(calls[0]?.body ?? {})).toEqual(['question']);
    const body = outcome.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.operation).toBe('ask');
    expect(body.usage).toEqual(RECEIPT);
    expect(body.answer).toBe('Use `moda canvas markup` for the first page.');
    const meta = body.meta as Record<string, unknown>;
    expect(typeof meta.duration_ms).toBe('number');
    expect(outcome.exitCode).toBe(0);
  });

  test('--context travels as the optional context field', async () => {
    const { base, calls } = serve(() => Response.json({ answer: 'a', usage: RECEIPT }));
    await performAsk(client(base), { question: 'why did this fail?', context: 'exit 5 STALE_REVISION on canvas edit' });
    expect(Object.keys(calls[0]?.body ?? {}).sort()).toEqual(['context', 'question']);
    expect(calls[0]?.body.context).toBe('exit 5 STALE_REVISION on canvas edit');
  });

  test('question is trimmed; empty and over-cap inputs fail typed as usage before any request', async () => {
    const { base, calls } = serve(() => Response.json({ answer: 'a', usage: RECEIPT }));
    const c = client(base);
    for (const bad of ['', '   ']) {
      await expect(performAsk(c, { question: bad })).rejects.toThrow(CliError);
    }
    try {
      await performAsk(c, { question: 'x'.repeat(MAX_QUESTION_CHARS + 1) });
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.code).toBe('usage');
      expect((err as CliError).fields.message).toContain(String(MAX_QUESTION_CHARS));
    }
    try {
      await performAsk(c, { question: 'q', context: 'x'.repeat(MAX_CONTEXT_CHARS + 1) });
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.code).toBe('usage');
      expect((err as CliError).fields.message).toContain(String(MAX_CONTEXT_CHARS));
    }
    expect(calls.length).toBe(0);
    await performAsk(c, { question: '  padded question  ' });
    expect(calls[0]?.body.question).toBe('padded question');
  });

  test("a BARE route 404 names the server-predates truth; an envelope'd not_found passes through", async () => {
    const { base } = serve(() => new Response('Not Found', { status: 404 }));
    try {
      await performAsk(client(base), { question: 'q' });
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.message).toBe('This server predates the ask endpoint.');
      expect((err as CliError).fields.hint).toContain('moda describe');
    }
    server?.stop(true);
    const enveloped = serve(() =>
      new Response(JSON.stringify({ error: { type: 'not_found', code: 'not_found', message: 'no such thing' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    try {
      await performAsk(client(enveloped.base), { question: 'q' });
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.code).toBe('not_found');
      expect((err as CliError).fields.message).toBe('no such thing');
    }
  });

  test('human output renders the answer, then citations and pointers as bullet lines', async () => {
    const { base } = serve(() =>
      Response.json({
        answer: 'Read first, then edit.',
        citations: ['canvas read refreshes the revision', { verb: 'canvas edit', quote: 'writes pin the revision' }],
        pointers: [{ skill: 'moda-edit', reference: 'reading-and-verifying.md' }],
        usage: RECEIPT,
      }),
    );
    const lines = humanLines(await performAsk(client(base), { question: 'how do I edit safely?' }));
    expect(lines[0]).toBe('Read first, then edit.');
    expect(lines).toContain('Cited:');
    expect(lines).toContain('  - canvas read refreshes the revision');
    expect(lines).toContain('  - canvas edit — writes pin the revision');
    expect(lines).toContain('See also:');
    expect(lines).toContain('  - moda-edit — reading-and-verifying.md');
  });

  test('an answer-less envelope degrades to the raw body rather than hiding the response', async () => {
    const { base } = serve(() => Response.json({ note: 'unexpected shape', usage: RECEIPT }));
    const lines = humanLines(await performAsk(client(base), { question: 'q' }));
    expect(lines.join('\n')).toContain('unexpected shape');
  });
});

describe('renderEntry (tolerant citation shapes)', () => {
  test('strings pass through; known fields join in display order; unknown shapes stringify', () => {
    expect(renderEntry('plain text')).toBe('plain text');
    expect(renderEntry({ verb: 'export', reference: 'export.md' })).toBe('export — export.md');
    expect(renderEntry({ mystery: 1 })).toBe('{"mystery":1}');
    expect(renderEntry(42)).toBe('42');
  });
});

describe('ask registration (schema + house epilogue)', () => {
  test('markers: a pure read — not mutating, not metered, not destructive, no revision token', () => {
    const ask = collectVerbs(buildProgram(), '').find((verb) => verb.name === 'ask');
    expect(ask).toBeDefined();
    expect(ask?.markers).toEqual({ mutating: false, destructive: false, metered: false, read_lane: false });
    expect(ask?.flags.map((flag) => flag.flag)).toContain('--context');
    expect(ask?.positionals).toEqual([{ name: 'question', required: true, variadic: true }]);
  });

  test('ask carries the house help epilogue (Examples + Not for) and the ask-early steer', () => {
    const ask = buildProgram().commands.find((cmd) => cmd.name() === 'ask');
    let help = '';
    ask?.configureOutput({ writeOut: (text: string) => (help += text) });
    ask?.outputHelp();
    expect(help).toContain('Examples:');
    expect(help).toContain('Not for:');
    expect(help).toContain('Ask early and often');
  });
});
