/**
 * Agent-ergonomics wave: standard --version, compact-vs---pretty JSON, last-error persistence,
 * the task-start replay ledger, and the list-lane returned/empty sugar.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { statSync, readFileSync, writeFileSync } from 'node:fs';
import {
  clearLastError,
  persistLastError,
  readLastError,
  readTaskStart,
  recordTaskStart,
  recordTaskStatus,
} from '../src/config/state.ts';
import { detectStartReplay } from '../src/commands/task.ts';
import { passthroughOutcome } from '../src/commands/canvasShared.ts';
import type { Invocation } from '../src/commands/runtime.ts';

const MAIN = resolve(import.meta.dir, '../src/main.ts');

async function run(args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, MODA_NO_UPDATE_CHECK: '1' },
  });
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { code, stdout };
}

describe('standard --version flag', () => {
  test('moda --version exits 0 and prints the version', async () => {
    const { code, stdout } = await run(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('-V shorthand matches', async () => {
    const { code, stdout } = await run(['-V']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('--json is compact; --pretty opts in', () => {
  test('version --json emits exactly one compact line', async () => {
    const { code, stdout } = await run(['version', '--json']);
    expect(code).toBe(0);
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect((JSON.parse(stdout) as Record<string, unknown>).ok).toBe(true);
  });

  test('version --json --pretty is indented', async () => {
    const { code, stdout } = await run(['version', '--json', '--pretty']);
    expect(code).toBe(0);
    expect(stdout.split('\n').length).toBeGreaterThan(3);
    expect((JSON.parse(stdout) as Record<string, unknown>).ok).toBe(true);
  });
});

describe('last-error persistence', () => {
  test('persist → read round-trips the envelope and stamps exited_at', () => {
    const env = { MODA_STATE_DIR: mkdtempSync(join(tmpdir(), 'moda-lasterr-')) };
    expect(readLastError(env)).toBeUndefined();
    persistLastError({ ok: false, error: { type: 'conflict', code: 'stale_revision', message: 'stale' } }, env);
    const doc = readLastError(env);
    expect((doc?.error as Record<string, unknown>).code).toBe('stale_revision');
    expect(typeof doc?.exited_at).toBe('string');
  });

  test('moda last-error with no recorded failure exits typed not_found', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'moda-lasterr-cli-'));
    const proc = Bun.spawn(['bun', MAIN, 'last-error', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, MODA_STATE_DIR: scratch, MODA_NO_UPDATE_CHECK: '1' },
    });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(code).not.toBe(0);
    const body = JSON.parse(stdout) as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).code).toBe('no_last_error');
  });
});

describe('last-error security (review blocking finding)', () => {
  test('signed-URL + moda_live_ key envelope lands REDACTED on disk with mode 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moda-lasterr-sec-'));
    const env = { MODA_STATE_DIR: dir };
    persistLastError(
      {
        ok: false,
        error: {
          type: 'authentication',
          code: 'bad_key',
          message: 'key moda_live_deadbeef4321aa rejected',
          details: { artifact: 'https://cdn.example.com/file.png?Signature=SUPERSECRETSIG&x=1' },
        },
      },
      env,
    );
    const raw = readFileSync(join(dir, 'last-error.json'), 'utf8');
    expect(raw).not.toContain('moda_live_deadbeef4321aa');
    expect(raw).not.toContain('SUPERSECRETSIG');
    expect(raw).toContain('[REDACTED]');
    expect(statSync(join(dir, 'last-error.json')).mode & 0o777).toBe(0o600);
  });

  test('a pre-existing world-readable file is chmodded down on the next persist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moda-lasterr-chmod-'));
    const env = { MODA_STATE_DIR: dir };
    writeFileSync(join(dir, 'last-error.json'), '{}', { mode: 0o644 });
    persistLastError({ ok: false, error: { type: 'x', code: 'y', message: 'z' } }, env);
    expect(statSync(join(dir, 'last-error.json')).mode & 0o777).toBe(0o600);
  });

  test('clearLastError removes the record (zero-exit path)', () => {
    const env = { MODA_STATE_DIR: mkdtempSync(join(tmpdir(), 'moda-lasterr-clear-')) };
    persistLastError({ ok: false, error: { type: 'x', code: 'y', message: 'z' } }, env);
    expect(readLastError(env)).toBeDefined();
    clearLastError(env);
    expect(readLastError(env)).toBeUndefined();
  });
});

describe('detectStartReplay (skew-safe replay claims)', () => {
  const NOW = Date.parse('2026-08-11T12:00:00Z');

  test('ledger match is a confident claim and never re-records', () => {
    const verdict = detectStartReplay({
      taskId: 'task_1',
      fresh: false,
      prior: { task_id: 'task_1', started_at: 'x', last_status: 'failed' },
      localNowMs: NOW,
    });
    expect(verdict.replayed).toBe(true);
    expect(verdict.note).toContain('last seen failed');
    expect(verdict.record).toBe(false);
  });

  test('skewed-ahead LOCAL clock alone never claims replay — hedged note only', () => {
    // Local clock 60s ahead of the server: created_at appears 60s in the past. No server time.
    const verdict = detectStartReplay({
      taskId: 'task_2',
      fresh: false,
      createdAtMs: NOW - 60_000,
      localNowMs: NOW,
    });
    expect(verdict.replayed).toBe(false);
    expect(verdict.note).toContain('possible replay');
    expect(verdict.note).not.toContain('pass --fresh');
  });

  test('server Date header is the trusted reference: predate → confident claim', () => {
    const verdict = detectStartReplay({
      taskId: 'task_3',
      fresh: false,
      createdAtMs: NOW - 60_000,
      serverNowMs: NOW,
      localNowMs: NOW + 3_600_000, // local clock wildly ahead — irrelevant
    });
    expect(verdict.replayed).toBe(true);
    expect(verdict.note).toContain('pass --fresh');
  });

  test('fresh starts are NEVER recorded (salted keys would evict the real ledger)', () => {
    const verdict = detectStartReplay({ taskId: 'task_4', fresh: true, localNowMs: NOW });
    expect(verdict.replayed).toBe(false);
    expect(verdict.record).toBe(false);
    const normal = detectStartReplay({ taskId: 'task_5', fresh: false, localNowMs: NOW });
    expect(normal.record).toBe(true);
  });
});

describe('task-start replay ledger', () => {
  test('record → read → terminal-status update', () => {
    const env = { MODA_STATE_DIR: mkdtempSync(join(tmpdir(), 'moda-ledger-')) };
    expect(readTaskStart('ik_x', env)).toBeUndefined();
    recordTaskStart('ik_x', { task_id: 'task_1', started_at: new Date().toISOString() }, env);
    expect(readTaskStart('ik_x', env)?.task_id).toBe('task_1');
    recordTaskStatus('task_1', 'failed', env);
    expect(readTaskStart('ik_x', env)?.last_status).toBe('failed');
  });
});

describe('list-lane sugar (passthroughOutcome)', () => {
  const inv = { flags: {}, note: () => {} } as unknown as Invocation;
  const wire = (body: unknown) => ({ body, requestId: 'req_1', durationMs: 5 });

  function humanLines(outcome: { human?: (write: (line: string) => void) => void }): string[] {
    const lines: string[] = [];
    outcome.human?.((line) => lines.push(line));
    return lines;
  }

  test('returned counts the items array; no hint when non-empty', () => {
    const outcome = passthroughOutcome('canvas.search', wire({ canvases: [{ id: 'x' }, { id: 'y' }] }), inv, {
      emptyHint: 'unused',
    });
    expect((outcome.body as Record<string, unknown>).returned).toBe(2);
    expect(outcome.human).toBeUndefined();
  });

  test('zero results renders the steering line', () => {
    const outcome = passthroughOutcome('canvas.search', wire({ canvases: [] }), inv, {
      emptyHint: "no results for 'q' — broaden the query or try moda canvas list",
    });
    expect((outcome.body as Record<string, unknown>).returned).toBe(0);
    expect(humanLines(outcome)).toEqual(["no results for 'q' — broaden the query or try moda canvas list"]);
  });

  test('non-list passthrough is unchanged (no returned field)', () => {
    const outcome = passthroughOutcome('brand.show', wire({ id: 'bk_1' }), inv);
    expect((outcome.body as Record<string, unknown>).returned).toBeUndefined();
  });
});
