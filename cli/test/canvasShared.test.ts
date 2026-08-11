import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../src/cliError.ts';
import { writeRevisionEntry, readRevisionEntry } from '../src/config/state.ts';
import { cacheFromResponse, chooseRevision, parseSize } from '../src/commands/canvasShared.ts';

function tempEnv(): NodeJS.ProcessEnv {
  return { MODA_STATE_DIR: mkdtempSync(join(tmpdir(), 'moda-canvas-')) };
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

describe('parseSize', () => {
  test('parses WxH; rejects garbage', () => {
    expect(parseSize('1920x1080')).toEqual({ width: 1920, height: 1080 });
    expect(parseSize(' 800X600 ')).toEqual({ width: 800, height: 600 });
    expect(() => parseSize('16:9')).toThrow(CliError);
    expect(() => parseSize('x')).toThrow(CliError);
  });
});
