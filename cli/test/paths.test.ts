/**
 * Config/state directory resolution across platforms. The platform is injected (the
 * `browserArgv` pattern) so the Windows branches are covered from the POSIX CI runner.
 */
import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configDir, configFilePath, credentialsFilePath, stateDir } from '../src/config/paths.ts';

const WIN_ENV: NodeJS.ProcessEnv = {
  APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
};

describe('explicit overrides win everywhere', () => {
  test('MODA_CONFIG_DIR / MODA_STATE_DIR beat both XDG and the Windows profile vars', () => {
    const env = { ...WIN_ENV, MODA_CONFIG_DIR: 'X:\\cfg', MODA_STATE_DIR: 'X:\\st', XDG_CONFIG_HOME: '/xdg' };
    expect(configDir(env, 'win32')).toBe('X:\\cfg');
    expect(stateDir(env, 'win32')).toBe('X:\\st');
    expect(configDir(env, 'linux')).toBe('X:\\cfg');
  });
});

describe('posix', () => {
  test('XDG when set, the XDG defaults otherwise', () => {
    expect(configDir({ XDG_CONFIG_HOME: '/x/cfg' }, 'linux')).toBe(join('/x/cfg', 'moda'));
    expect(stateDir({ XDG_STATE_HOME: '/x/state' }, 'linux')).toBe(join('/x/state', 'moda'));
    expect(configDir({}, 'linux')).toBe(join(homedir(), '.config', 'moda'));
    expect(stateDir({}, 'linux')).toBe(join(homedir(), '.local', 'state', 'moda'));
  });

  test('an empty XDG variable is "unset", not the current directory', () => {
    expect(configDir({ XDG_CONFIG_HOME: '' }, 'linux')).toBe(join(homedir(), '.config', 'moda'));
    expect(stateDir({ XDG_STATE_HOME: '' }, 'linux')).toBe(join(homedir(), '.local', 'state', 'moda'));
  });
});

describe('win32', () => {
  test('roaming APPDATA for config, machine-local LOCALAPPDATA for state — and they differ', () => {
    expect(configDir(WIN_ENV, 'win32')).toBe(join('C:\\Users\\dev\\AppData\\Roaming', 'moda'));
    expect(stateDir(WIN_ENV, 'win32')).toBe(join('C:\\Users\\dev\\AppData\\Local', 'moda'));
    expect(configDir(WIN_ENV, 'win32')).not.toBe(stateDir(WIN_ENV, 'win32'));
  });

  test('XDG still wins when a shell (Git Bash / MSYS) sets it on Windows', () => {
    expect(configDir({ ...WIN_ENV, XDG_CONFIG_HOME: '/c/xdg' }, 'win32')).toBe(join('/c/xdg', 'moda'));
    expect(stateDir({ ...WIN_ENV, XDG_STATE_HOME: '/c/xdgs' }, 'win32')).toBe(join('/c/xdgs', 'moda'));
  });

  test('a profile-less environment (service account) still resolves, via the XDG shape', () => {
    expect(configDir({}, 'win32')).toBe(join(homedir(), '.config', 'moda'));
    expect(stateDir({ LOCALAPPDATA: '' }, 'win32')).toBe(join(homedir(), '.local', 'state', 'moda'));
  });

  test('the config-dir files ride the same platform decision', () => {
    expect(configFilePath(WIN_ENV, 'win32')).toBe(join(configDir(WIN_ENV, 'win32'), 'config.toml'));
    expect(credentialsFilePath(WIN_ENV, 'win32')).toBe(join(configDir(WIN_ENV, 'win32'), 'credentials.json'));
  });
});
