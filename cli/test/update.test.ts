import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUpdateStamp, writeUpdateStamp } from '../src/config/state.ts';
import { compareVersions, maybeUpdateNotice, recordVersionHeaders, updateAvailable } from '../src/update.ts';

function tempEnv(): NodeJS.ProcessEnv {
  return { MODA_STATE_DIR: mkdtempSync(join(tmpdir(), 'moda-update-')) };
}

describe('version comparison', () => {
  test('orders plain semver and prereleases', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.1.0-dev', '0.1.0')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
  });
});

describe('version headers + stderr notice discipline (cli.md §14)', () => {
  test('records headers off responses and reports update availability', () => {
    const env = tempEnv();
    const headers = new Headers({ 'Moda-Cli-Latest-Version': '9.9.9', 'Moda-Cli-Minimum-Version': '0.0.1' });
    recordVersionHeaders(headers, env);
    const stamp = readUpdateStamp(env);
    expect(stamp.latest).toBe('9.9.9');
    expect(stamp.minimum_supported).toBe('0.0.1');
    expect(updateAvailable(env)?.latest).toBe('9.9.9');
  });

  test('missing headers stay silent (offline ⇒ no stamp churn)', () => {
    const env = tempEnv();
    recordVersionHeaders(new Headers(), env);
    expect(readUpdateStamp(env)).toEqual({});
  });

  test('notice fires at most once per day per version', () => {
    const env = tempEnv();
    writeUpdateStamp({ latest: '9.9.9' }, env);
    const t0 = new Date('2026-08-10T10:00:00Z');
    const first = maybeUpdateNotice(env, t0);
    expect(first).toContain('9.9.9');
    expect(first).toContain('moda update');
    // Same day: suppressed.
    expect(maybeUpdateNotice(env, new Date('2026-08-10T22:00:00Z'))).toBeUndefined();
    // Next day: fires again.
    expect(maybeUpdateNotice(env, new Date('2026-08-11T11:00:00Z'))).toContain('9.9.9');
    // A NEW latest version fires immediately even within the day.
    writeUpdateStamp({ ...readUpdateStamp(env), latest: '10.0.0' }, env);
    expect(maybeUpdateNotice(env, new Date('2026-08-11T11:05:00Z'))).toContain('10.0.0');
  });

  test('MODA_NO_UPDATE_CHECK=1 disables the notice; up-to-date CLI never notices', () => {
    const env = tempEnv();
    writeUpdateStamp({ latest: '9.9.9' }, env);
    expect(maybeUpdateNotice({ ...env, MODA_NO_UPDATE_CHECK: '1' })).toBeUndefined();
    const env2 = tempEnv();
    writeUpdateStamp({ latest: '0.0.1' }, env2);
    expect(maybeUpdateNotice(env2)).toBeUndefined();
  });
});
