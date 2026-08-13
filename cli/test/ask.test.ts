/**
 * `moda ask` unit lane: the HTTP layer is a local mock server (client.test.ts pattern) and the
 * command logic is exercised through the exported performAsk helper. Locks the binding backend
 * contract: POST /v1/ask {question, context?, session_id?, brand_kit_ref?} → {answer, citations?,
 * session_id, usage: {class: "assisted", metered_credits: 0}} — the free advisory lane — plus the
 * session-continuity recovery lanes and the server-predates-endpoint posture.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient } from '../src/api/client.ts';
import { CliError } from '../src/cliError.ts';
import { buildProgram } from '../src/main.ts';
import { collectVerbs } from '../src/commands/meta.ts';
import { readAskSession, writeAskSession } from '../src/config/state.ts';
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

  test('required_reading renders too — the router-not-oracle field is never dropped from human output', async () => {
    const { base } = serve(() =>
      Response.json({ answer: 'Load the skill first.', required_reading: [{ skill: 'moda-deck', reference: 'deck-design.md' }], session_id: 'ask_1', usage: RECEIPT }),
    );
    const lines = humanLines(await performAsk(client(base), { question: 'how do I build a deck?' }));
    expect(lines).toContain('Read first:');
    expect(lines).toContain('  - moda-deck — deck-design.md');
  });

  test('an answer-less envelope degrades to the raw body rather than hiding the response', async () => {
    const { base } = serve(() => Response.json({ note: 'unexpected shape', usage: RECEIPT }));
    const lines = humanLines(await performAsk(client(base), { question: 'q' }));
    expect(lines.join('\n')).toContain('unexpected shape');
  });
});

describe('ask sessions (v2 continuity)', () => {
  const ACCOUNT = 'api.moda.test/acme';
  let stateDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'moda-ask-session-'));
    env = { MODA_STATE_DIR: stateDir };
  });
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  /** A server that mints on a session-less call and echoes whatever id it is given. */
  function sessionServer(minted = 'ask_' + '0'.repeat(32)) {
    return serve((_req, body) =>
      Response.json({ answer: 'a', session_id: (body.session_id as string | undefined) ?? minted, usage: RECEIPT }),
    );
  }

  function notices(): { note: (m: string) => void; lines: string[] } {
    const lines: string[] = [];
    return { note: (m) => lines.push(m), lines };
  }

  test('first ask sends no session_id and persists the id the server minted', async () => {
    const { base, calls } = sessionServer('ask_beef');
    await performAsk(client(base), { question: 'q', accountKey: ACCOUNT, env });
    expect(calls[0]?.body.session_id).toBeUndefined();
    expect(readAskSession(ACCOUNT, env)).toBe('ask_beef');
  });

  test('the next ask reuses the remembered id — follow-ups keep context with no flag', async () => {
    const { base, calls } = sessionServer('ask_beef');
    const c = client(base);
    await performAsk(c, { question: 'first', accountKey: ACCOUNT, env });
    await performAsk(c, { question: 'follow-up', accountKey: ACCOUNT, env });
    expect(calls[1]?.body.session_id).toBe('ask_beef');
    expect(readAskSession(ACCOUNT, env)).toBe('ask_beef');
  });

  test('the remembered id is per account key — another account does not inherit it', async () => {
    const { base, calls } = sessionServer('ask_other');
    writeAskSession(ACCOUNT, 'ask_beef', env);
    await performAsk(client(base), { question: 'q', accountKey: 'api.moda.test/other', env });
    expect(calls[0]?.body.session_id).toBeUndefined();
    expect(readAskSession(ACCOUNT, env)).toBe('ask_beef');
  });

  test('--fresh ignores the remembered id and overwrites it with the newly minted one', async () => {
    const { base, calls } = sessionServer('ask_new');
    writeAskSession(ACCOUNT, 'ask_old', env);
    await performAsk(client(base), { question: 'q', fresh: true, accountKey: ACCOUNT, env });
    expect(calls[0]?.body.session_id).toBeUndefined();
    expect(readAskSession(ACCOUNT, env)).toBe('ask_new');
  });

  test('--session <id> continues that id explicitly and persists it', async () => {
    const { base, calls } = sessionServer();
    writeAskSession(ACCOUNT, 'ask_old', env);
    await performAsk(client(base), { question: 'q', sessionId: 'ask_named', accountKey: ACCOUNT, env });
    expect(calls[0]?.body.session_id).toBe('ask_named');
    expect(readAskSession(ACCOUNT, env)).toBe('ask_named');
  });

  test('--fresh with --session fails typed as usage before any request', async () => {
    const { base, calls } = sessionServer();
    await expect(
      performAsk(client(base), { question: 'q', fresh: true, sessionId: 'ask_x', accountKey: ACCOUNT, env }),
    ).rejects.toThrow(CliError);
    expect(calls.length).toBe(0);
  });

  test('a 410 session_expired retries ONCE without the id, notices it, and persists the new session', async () => {
    const { base, calls } = serve((_req, body) =>
      body.session_id !== undefined
        ? new Response(
            JSON.stringify({
              error: { type: 'not_found', code: 'session_expired', message: 'This session expired after 24 hours idle.', retryable: false },
            }),
            { status: 410, headers: { 'Content-Type': 'application/json' } },
          )
        : Response.json({ answer: 'a', session_id: 'ask_reborn', usage: RECEIPT }),
    );
    const { note, lines } = notices();
    writeAskSession(ACCOUNT, 'ask_stale', env);
    const outcome = await performAsk(client(base), { question: 'q', accountKey: ACCOUNT, env, note });
    expect(calls.map((c) => c.body.session_id)).toEqual(['ask_stale', undefined]);
    expect(lines).toEqual(['previous ask session expired — started a new one']);
    expect((outcome.body as Record<string, unknown>).session_id).toBe('ask_reborn');
    expect(readAskSession(ACCOUNT, env)).toBe('ask_reborn');
  });

  test('a 404 on the REMEMBERED id recovers the same way; a second failure is not retried again', async () => {
    const unknown = () =>
      new Response(
        JSON.stringify({ error: { type: 'not_found', code: 'not_found', message: 'Unknown session_id. Omit session_id to start a new session.' } }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );
    const { base, calls } = serve((_req, body) =>
      body.session_id !== undefined ? unknown() : Response.json({ answer: 'a', session_id: 'ask_fresh', usage: RECEIPT }),
    );
    const { note, lines } = notices();
    writeAskSession(ACCOUNT, 'ask_wiped', env);
    await performAsk(client(base), { question: 'q', accountKey: ACCOUNT, env, note });
    expect(calls.length).toBe(2);
    expect(lines).toEqual(['previous ask session is no longer available — started a new one']);
    expect(readAskSession(ACCOUNT, env)).toBe('ask_fresh');

    // The retry itself is never retried: a server that 404s the session-less call fails typed.
    server?.stop(true);
    const always = serve(() => unknown());
    await expect(performAsk(client(always.base), { question: 'q', accountKey: ACCOUNT, env })).rejects.toThrow(CliError);
    expect(always.calls.length).toBe(2);
  });

  test('a 404 on an EXPLICIT --session id fails typed instead of silently answering elsewhere', async () => {
    const { base, calls } = serve(() =>
      new Response(
        JSON.stringify({ error: { type: 'not_found', code: 'not_found', message: 'Unknown session_id. Omit session_id to start a new session.' } }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    try {
      await performAsk(client(base), { question: 'q', sessionId: 'ask_typo', accountKey: ACCOUNT, env });
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.code).toBe('not_found');
    }
    expect(calls.length).toBe(1);
    expect(readAskSession(ACCOUNT, env)).toBeUndefined();
  });

  test("a 404 that is NOT about a session (route gate, brand kit) never triggers the fresh retry", async () => {
    const { base, calls } = serve(() =>
      new Response(JSON.stringify({ error: { type: 'not_found', code: 'not_found', message: 'Not Found' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    writeAskSession(ACCOUNT, 'ask_kept', env);
    await expect(performAsk(client(base), { question: 'q', accountKey: ACCOUNT, env })).rejects.toThrow(CliError);
    expect(calls.length).toBe(1);
    expect(readAskSession(ACCOUNT, env)).toBe('ask_kept');
  });

  test('a session-less server (pre-v2) leaves the remembered id untouched rather than clearing it', async () => {
    const { base } = serve(() => Response.json({ answer: 'a', usage: RECEIPT }));
    writeAskSession(ACCOUNT, 'ask_kept', env);
    await performAsk(client(base), { question: 'q', sessionId: 'ask_kept', accountKey: ACCOUNT, env });
    expect(readAskSession(ACCOUNT, env)).toBe('ask_kept');
  });
});

describe('ask --brand (v1.1 brand grounding — opt-in only)', () => {
  test('--brand travels as brand_kit_ref; without it the field is absent entirely', async () => {
    const { base, calls } = serve(() => Response.json({ answer: 'a', session_id: 'ask_1', usage: RECEIPT }));
    const c = client(base);
    await performAsk(c, { question: 'which palette?', brand: 'bk_123' });
    expect(calls[0]?.body.brand_kit_ref).toBe('bk_123');
    await performAsk(c, { question: 'which palette?' });
    expect(Object.keys(calls[1]?.body ?? {})).toEqual(['question']);
  });

  test('an unknown kit surfaces the server 404 plainly and names moda brand list', async () => {
    const { base } = serve(() =>
      new Response(JSON.stringify({ error: { type: 'not_found', code: 'not_found', message: 'Brand kit not found' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    try {
      await performAsk(client(base), { question: 'q', brand: 'bk_nope' });
      expect.unreachable();
    } catch (err) {
      const fields = (err as CliError).fields;
      expect(fields.code).toBe('not_found');
      expect(fields.message).toBe('Brand kit not found');
      expect(fields.hint).toContain('moda brand list');
    }
  });

  test('a key without the brand_kits:read scope says so instead of leaking a bare 403', async () => {
    const { base } = serve(() =>
      new Response(
        JSON.stringify({ error: { type: 'permission', code: 'permission', message: 'API key missing required scope: brand_kits:read' } }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    try {
      await performAsk(client(base), { question: 'q', brand: 'bk_1' });
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.hint).toContain('brand_kits:read');
    }
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
    const flags = ask?.flags.map((flag) => flag.flag) ?? [];
    for (const flag of ['--context', '--fresh', '--session', '--brand']) expect(flags).toContain(flag);
    expect(ask?.positionals).toEqual([{ name: 'question', required: true, variadic: true }]);
  });

  test('ask carries the house help epilogue (Examples + Not for), the ask-early steer, and the session/brand lines', () => {
    const ask = buildProgram().commands.find((cmd) => cmd.name() === 'ask');
    let help = '';
    ask?.configureOutput({ writeOut: (text: string) => (help += text) });
    ask?.outputHelp();
    expect(help).toContain('Examples:');
    expect(help).toContain('Not for:');
    expect(help).toContain('Ask early and often');
    expect(help).toContain('Follow-ups keep context automatically');
    expect(help).toContain('--fresh to reset');
    expect(help).toContain('grounds answers in a brand kit');
  });
});
