import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../src/cliError.ts';
import { writeRevisionEntry, readRevisionEntry } from '../src/config/state.ts';
import { cacheFromResponse, chooseRevision, mutationOutcome, parseSize } from '../src/commands/canvasShared.ts';
import type { Invocation } from '../src/commands/runtime.ts';

function tempEnv(): NodeJS.ProcessEnv {
  return { MODA_STATE_DIR: mkdtempSync(join(tmpdir(), 'moda-canvas-')) };
}

function fakeInvocation(env: NodeJS.ProcessEnv): Invocation {
  return {
    flags: { json: true, quiet: false, noInput: true },
    context: { apiBase: { value: 'https://api.example', source: 'default' }, org: { source: 'default' } },
    env,
    emitOpts: { json: true, quiet: false },
    note: () => {},
  } as unknown as Invocation;
}

describe('chooseRevision', () => {
  test('flag beats cache; cache is the default; required-with-nothing is a loud usage error', () => {
    const env = tempEnv();
    writeRevisionEntry('cvs_A', { revision: 'crdt-cached', short_ids: ['n1'], read_at: 'now' }, env);
    expect(chooseRevision('cvs_A', 'crdt-flag', true, env)).toEqual({ expectedRevision: 'crdt-flag', source: 'flag' });
    expect(chooseRevision('cvs_A', undefined, true, env)).toEqual({ expectedRevision: 'crdt-cached', source: 'cache' });
    expect(chooseRevision('cvs_B', undefined, false, env)).toEqual({ source: 'none' });
    try {
      chooseRevision('cvs_B', undefined, true, env);
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.hint).toContain('moda canvas read');
    }
  });
});

describe('cacheFromResponse', () => {
  test('caches the revision under the input ref and both returned identifier forms', () => {
    const env = tempEnv();
    cacheFromResponse('cvs_INPUT', { revision: 'crdt-9', canvas: { id: 'cvs_RET', uuid: 12345 } }, env);
    expect(readRevisionEntry('cvs_INPUT', env)?.revision).toBe('crdt-9');
    expect(readRevisionEntry('cvs_RET', env)?.revision).toBe('crdt-9');
    expect(readRevisionEntry('12345', env)).toBeUndefined();
  });

  test('read path stores short ids for the staleness warning', () => {
    const env = tempEnv();
    cacheFromResponse('cvs_A', { revision: 'crdt-1' }, env, '# p_a\n n7 rect\n n9 text img2');
    const entry = readRevisionEntry('cvs_A', env);
    expect(entry?.short_ids).toEqual(['img2', 'n7', 'n9', 'p_a']);
  });

  test('no revision in the body means no cache write', () => {
    const env = tempEnv();
    cacheFromResponse('cvs_A', { committed: true }, env);
    expect(readRevisionEntry('cvs_A', env)).toBeUndefined();
  });
});

describe('revision pin-cache lanes (rulings §15: reads only, mutation tokens are advisory)', () => {
  test('a mutation response never populates the cache, even when it carries a revision', () => {
    const env = tempEnv();
    const outcome = mutationOutcome('canvas.edit', 'cvs_A', fakeInvocation(env), {
      body: { revision: 'crdt-advisory', canvas: { id: 'cvs_RET' }, committed: true },
      durationMs: 10,
    });
    expect(readRevisionEntry('cvs_A', env)).toBeUndefined();
    expect(readRevisionEntry('cvs_RET', env)).toBeUndefined();
    // The advisory token is still DISPLAYED on the response document and human line.
    expect((outcome.body as Record<string, unknown>).revision).toBe('crdt-advisory');
    const lines: string[] = [];
    outcome.human?.((line) => lines.push(line));
    expect(lines.join('\n')).toContain('crdt-advisory');
  });

  test('a mutation does not overwrite an existing read-sourced pin', () => {
    const env = tempEnv();
    cacheFromResponse('cvs_A', { revision: 'crdt-from-read' }, env, '# p_a\n n1 rect');
    mutationOutcome('canvas.edit', 'cvs_A', fakeInvocation(env), {
      body: { revision: 'crdt-advisory-newer' },
      durationMs: 10,
    });
    expect(readRevisionEntry('cvs_A', env)?.revision).toBe('crdt-from-read');
  });

  test('append-mode markup after a mutation with no intervening read sends NO expected_revision', () => {
    const env = tempEnv();
    // A mutation happened (advisory token in the response) but no read ever cached a pin.
    mutationOutcome('canvas.create_from_markup', 'cvs_A', fakeInvocation(env), {
      body: { revision: 'crdt-advisory' },
      durationMs: 10,
    });
    // append-mode markup: revision not required — must fall through to none, not the advisory token.
    expect(chooseRevision('cvs_A', undefined, false, env)).toEqual({ source: 'none' });
  });

  test('explicit --revision still passes through after a mutation', () => {
    const env = tempEnv();
    mutationOutcome('canvas.edit', 'cvs_A', fakeInvocation(env), { body: { revision: 'crdt-advisory' }, durationMs: 1 });
    expect(chooseRevision('cvs_A', 'crdt-explicit', false, env)).toEqual({
      expectedRevision: 'crdt-explicit',
      source: 'flag',
    });
  });

  test('a read populates the cache and the next append-mode mutation pins from it', () => {
    const env = tempEnv();
    cacheFromResponse('cvs_A', { revision: 'crdt-read-1' }, env, '# p_a\n n1 rect');
    expect(chooseRevision('cvs_A', undefined, false, env)).toEqual({
      expectedRevision: 'crdt-read-1',
      source: 'cache',
    });
  });
});

describe('idempotent replay surfacing (server contract: replayed / reused_existing / note)', () => {
  test('a replayed CREATE is loud: REUSED warning with the original created_at, server note, fields verbatim', () => {
    const env = tempEnv();
    const outcome = mutationOutcome('canvas.create', '', fakeInvocation(env), {
      body: {
        committed: true,
        replayed: true,
        reused_existing: true,
        created_at: '2026-08-09T21:14:00+00:00',
        note: 'REUSED EXISTING CANVAS — this call did NOT create a new canvas.',
        canvas: { id: 'cvs_R' },
        revision: 'crdt-orig',
      },
      requestId: 'req_1',
      durationMs: 10,
    });
    // --json carries the server fields verbatim.
    const body = outcome.body as Record<string, unknown>;
    expect(body.replayed).toBe(true);
    expect(body.reused_existing).toBe(true);
    expect(body.created_at).toBe('2026-08-09T21:14:00+00:00');
    expect(body.note).toBe('REUSED EXISTING CANVAS — this call did NOT create a new canvas.');
    // Human output leads with the loud reuse warning.
    const lines: string[] = [];
    outcome.human?.((line) => lines.push(line));
    expect(lines[0]).toBe(
      '⚠ REUSED existing canvas (created 2026-08-09T21:14:00+00:00) — server replayed your idempotency key; ' +
        'use a new name/key for a fresh canvas',
    );
    expect(lines[1]).toContain('REUSED EXISTING CANVAS');
    expect(lines.join('\n')).toContain('replayed (stored result — not re-applied)');
    expect(lines.join('\n')).not.toContain('canvas.create: committed');
  });

  test('a replayed MUTATION is loud: REPLAYED warning, no reuse phrasing, fields verbatim', () => {
    const env = tempEnv();
    const outcome = mutationOutcome('canvas.create_from_markup', 'cvs_A', fakeInvocation(env), {
      body: { committed: true, replayed: true, revision: 'crdt-stored' },
      durationMs: 5,
    });
    expect((outcome.body as Record<string, unknown>).replayed).toBe(true);
    const lines: string[] = [];
    outcome.human?.((line) => lines.push(line));
    expect(lines[0]).toContain('⚠ REPLAYED');
    expect(lines[0]).toContain('nothing was applied again');
    expect(lines.join('\n')).not.toContain('REUSED existing canvas');
    expect(lines.join('\n')).toContain('canvas.create_from_markup: replayed (stored result — not re-applied)');
  });

  test('a normal mutation stays quiet: no warning, committed line unchanged', () => {
    const env = tempEnv();
    const outcome = mutationOutcome('canvas.edit', 'cvs_A', fakeInvocation(env), {
      body: { committed: true, revision: 'crdt-1' },
      durationMs: 5,
    });
    expect((outcome.body as Record<string, unknown>).replayed).toBeUndefined();
    const lines: string[] = [];
    outcome.human?.((line) => lines.push(line));
    expect(lines[0]).toBe('canvas.edit: committed (advisory revision crdt-1 — pin only from reads)');
    expect(lines.join('\n')).not.toContain('⚠');
  });
});

describe('parseSize', () => {
  test('parses WxH; rejects garbage', () => {
    expect(parseSize('1920x1080')).toEqual({ width: 1920, height: 1080 });
    expect(parseSize(' 800X600 ')).toEqual({ width: 800, height: 600 });
    expect(() => parseSize('16:9')).toThrow(CliError);
    expect(() => parseSize('x')).toThrow(CliError);
  });
});
