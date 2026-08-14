import { describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileKeychain, selectKeychainBackend, keychainAccount } from '../src/auth/keychain.ts';
import type { StoredCredential } from '../src/auth/keychain.ts';

const SECRET: StoredCredential = {
  key: `moda_live_${'ab'.repeat(32)}`,
  org: 'org_1',
  scopes: ['canvases:write'],
  created_at: '2026-08-10T00:00:00Z',
  api_base: 'https://api.moda.app',
};

function tempEnv(): NodeJS.ProcessEnv {
  return { MODA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'moda-keychain-')) };
}

function writeShim(dir: string, name: string, script: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('file fallback', () => {
  test('stores 0600, round-trips, deletes', async () => {
    const env = tempEnv();
    const backend = new FileKeychain(env);
    await backend.store(keychainAccount('https://api.moda.app', 'org_1'), SECRET);
    const path = join(env.MODA_CONFIG_DIR as string, 'credentials.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const read = await backend.read('api.moda.app/org_1');
    expect(read?.key).toBe(SECRET.key);
    expect(read?.org).toBe('org_1');
    expect(await backend.delete('api.moda.app/org_1')).toBe(true);
    expect(await backend.read('api.moda.app/org_1')).toBeUndefined();
  });

  test('multiple accounts coexist (dev/prod, multi-org)', async () => {
    const env = tempEnv();
    const backend = new FileKeychain(env);
    await backend.store('api.moda.app/org_1', SECRET);
    await backend.store('localhost:8000/org_2', { ...SECRET, org: 'org_2' });
    expect((await backend.read('api.moda.app/org_1'))?.org).toBe('org_1');
    expect((await backend.read('localhost:8000/org_2'))?.org).toBe('org_2');
  });
});

describe('win32 (injected platform — covered from the POSIX runner)', () => {
  test('selects the file backend without probing for a POSIX keychain CLI', async () => {
    const backend = await selectKeychainBackend(tempEnv(), 'win32');
    expect(backend.name).toBe('file');
  });

  test('the fallback warning claims an ACL, never a mode bit Windows cannot set', async () => {
    const env = tempEnv();
    const written: string[] = [];
    const spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      written.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      await new FileKeychain(env, 'win32').store('api.moda.app/org_1', SECRET);
    } finally {
      spy.mockRestore();
    }
    const warning = written.join('');
    expect(warning).toContain('no OS keychain available');
    expect(warning).toContain('Windows user-profile ACL');
    expect(warning).not.toContain('0600');
  });

  test('POSIX still gets the 0600 claim, and it is true', async () => {
    const env = tempEnv();
    const written: string[] = [];
    const spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      written.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      await new FileKeychain(env, 'linux').store('api.moda.app/org_1', SECRET);
    } finally {
      spy.mockRestore();
    }
    expect(written.join('')).toContain('mode 0600');
    expect(statSync(join(env.MODA_CONFIG_DIR as string, 'credentials.json')).mode & 0o777).toBe(0o600);
  });

  test('credentials land under APPDATA, not a dotfolder in the user profile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moda-appdata-'));
    const env: NodeJS.ProcessEnv = { APPDATA: root };
    const backend = new FileKeychain(env, 'win32');
    await backend.store('api.moda.app/org_1', SECRET);
    expect(readFileSync(join(root, 'moda', 'credentials.json'), 'utf8')).toContain(SECRET.key);
    expect((await backend.read('api.moda.app/org_1'))?.key).toBe(SECRET.key);
  });
});

describe('macOS backend via shim (argv discipline)', () => {
  test('store passes the secret via argv to `security` (never a shell), read round-trips', async () => {
    const env = tempEnv();
    const bin = mkdtempSync(join(tmpdir(), 'moda-shim-'));
    const log = join(bin, 'calls.log');
    const store = join(bin, 'stored.json');
    writeShim(
      bin,
      'security',
      [
        `echo "$@" >> ${log}`,
        // add-generic-password: capture the -w argument (last); find-generic-password: print it back.
        `case "$1" in`,
        `  add-generic-password) for last; do true; done; printf %s "$last" > ${store} ;;`,
        `  find-generic-password) cat ${store} ;;`,
        `  delete-generic-password) rm -f ${store} ;;`,
        `esac`,
      ].join('\n'),
    );
    const testEnv = { ...env, MODA_KEYCHAIN: 'macos', MODA_SECURITY_BIN: join(bin, 'security') };
    const backend = await selectKeychainBackend(testEnv);
    expect(backend.name).toBe('macos-keychain');
    await backend.store('api.moda.app/org_1', SECRET);
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('add-generic-password');
    expect(calls).toContain('-s moda-cli');
    expect(calls).toContain('-a api.moda.app/org_1');
    const read = await backend.read('api.moda.app/org_1');
    expect(read?.key).toBe(SECRET.key);
    expect(await backend.delete('api.moda.app/org_1')).toBe(true);
  });
});

describe('secret-tool backend via PATH shim (stdin discipline)', () => {
  test('store passes the secret via STDIN (never argv); probe timeout falls back to file', async () => {
    if (process.platform !== 'linux') return;
    const env = tempEnv();
    const bin = mkdtempSync(join(tmpdir(), 'moda-shim2-'));
    const stored = join(bin, 'stored.json');
    const argvLog = join(bin, 'argv.log');
    writeShim(
      bin,
      'secret-tool',
      [
        `echo "$@" >> ${argvLog}`,
        `case "$1" in`,
        `  store) cat > ${stored} ;;`,
        `  lookup) cat ${stored} ;;`,
        `  clear) rm -f ${stored} ;;`,
        `  search) exit 0 ;;`,
        `esac`,
      ].join('\n'),
    );
    const priorPath = process.env.PATH;
    process.env.PATH = `${bin}:${priorPath}`;
    try {
      const testEnv = { ...env, PATH: process.env.PATH, DBUS_SESSION_BUS_ADDRESS: 'unix:mock', MODA_KEYCHAIN: 'secret-tool' };
      const backend = await selectKeychainBackend(testEnv);
      expect(backend.name).toBe('linux-secret-tool');
      await backend.store('api.moda.app/org_1', SECRET);
      // The secret must have arrived on stdin, and must never appear in argv.
      expect(readFileSync(stored, 'utf8')).toContain(SECRET.key);
      expect(readFileSync(argvLog, 'utf8')).not.toContain(SECRET.key);
      const read = await backend.read('api.moda.app/org_1');
      expect(read?.key).toBe(SECRET.key);
      expect(await backend.delete('api.moda.app/org_1')).toBe(true);
    } finally {
      process.env.PATH = priorPath;
    }
  });

  test('hanging probe (locked keyring) falls back to the file backend within the 2s timeout', async () => {
    if (process.platform !== 'linux') return;
    const env = tempEnv();
    const bin = mkdtempSync(join(tmpdir(), 'moda-shim3-'));
    writeShim(bin, 'secret-tool', 'case "$1" in search) sleep 30 ;; esac');
    const priorPath = process.env.PATH;
    process.env.PATH = `${bin}:${priorPath}`;
    try {
      const started = Date.now();
      const backend = await selectKeychainBackend({
        ...env,
        PATH: process.env.PATH,
        DBUS_SESSION_BUS_ADDRESS: 'unix:mock',
      });
      expect(backend.name).toBe('file');
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      process.env.PATH = priorPath;
    }
  }, 10_000);

  test('missing DBUS session address falls back to file without probing', async () => {
    if (process.platform !== 'linux') return;
    const env = tempEnv();
    const backend = await selectKeychainBackend({ ...env, DBUS_SESSION_BUS_ADDRESS: '' });
    expect(backend.name).toBe('file');
  });
});
