import { describe, expect, test } from 'bun:test';
import { CliError } from '../src/cliError.ts';
import { generateState, mintUrl, startLoginListener, stateMatches } from '../src/auth/login.ts';

describe('state nonce', () => {
  test('generateState is 32 bytes base64url and unique', () => {
    const a = generateState();
    const b = generateState();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  test('stateMatches is exact and tolerates length mismatch without throwing', () => {
    const s = generateState();
    expect(stateMatches(s, s)).toBe(true);
    expect(stateMatches(s, `${s}x`)).toBe(false);
    expect(stateMatches(s, '')).toBe(false);
    expect(stateMatches(s, 'short')).toBe(false);
  });
});

describe('login listener (scripted fake redirect)', () => {
  test('correct state delivers the key; page responds 200; listener shuts down', async () => {
    const state = generateState();
    const listener = startLoginListener(state, 10_000);
    expect(listener.port).toBeGreaterThan(0);
    const response = await fetch(
      `http://127.0.0.1:${listener.port}/callback?state=${encodeURIComponent(state)}&key=moda_live_${'0f'.repeat(32)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Logged in');
    const { key } = await listener.result;
    expect(key).toBe(`moda_live_${'0f'.repeat(32)}`);
  });

  test('state mismatch → 400 + typed error; a valid key is NOT accepted afterwards', async () => {
    const state = generateState();
    const listener = startLoginListener(state, 10_000);
    const bad = await fetch(`http://127.0.0.1:${listener.port}/callback?state=WRONG&key=k`);
    expect(bad.status).toBe(400);
    await expect(listener.result).rejects.toThrow(CliError);
    try {
      await listener.result;
    } catch (err) {
      expect((err as CliError).fields.code).toBe('state_mismatch');
      expect((err as CliError).fields.type).toBe('authentication');
    } finally {
      listener.close();
    }
  });

  test('non-callback paths 404 without settling the flow', async () => {
    const state = generateState();
    const listener = startLoginListener(state, 10_000);
    const favicon = await fetch(`http://127.0.0.1:${listener.port}/favicon.ico`);
    expect(favicon.status).toBe(404);
    const ok = await fetch(`http://127.0.0.1:${listener.port}/callback?state=${encodeURIComponent(state)}&key=abc`);
    expect(ok.status).toBe(200);
    await expect(listener.result).resolves.toEqual({ key: 'abc' });
  });

  test('timeout rejects with login_timeout and frees the port', async () => {
    const state = generateState();
    const listener = startLoginListener(state, 50);
    await expect(listener.result).rejects.toThrow('Timed out');
  });
});

describe('mint URL', () => {
  test('carries state, port, scopes, and name; paste variant omits port', () => {
    const url = new URL(mintUrl('https://moda.app', 'STATE123', 43210, ['canvases:write', 'designs:export']));
    expect(url.pathname).toBe('/cli/auth');
    expect(url.searchParams.get('state')).toBe('STATE123');
    expect(url.searchParams.get('port')).toBe('43210');
    expect(url.searchParams.get('scopes')).toBe('canvases:write,designs:export');
    expect(url.searchParams.get('name')).toContain('moda-cli on ');
    const pasteUrl = new URL(mintUrl('https://moda.app', 'S', undefined, undefined));
    expect(pasteUrl.searchParams.get('port')).toBeNull();
  });
});
