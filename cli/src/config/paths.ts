/**
 * Config/state directory resolution (cli.md §2.3). MODA_CONFIG_DIR / MODA_STATE_DIR override
 * wholesale, then the XDG variables (honoured on every platform — Git Bash / MSYS shells set
 * them on Windows too), then the platform default: Windows uses %APPDATA% (roaming: config and
 * credentials follow the user) and %LOCALAPPDATA% (machine-local: caches, stamps, screenshots),
 * everything else the XDG defaults. Windows falls back to the XDG shape only when the profile
 * variables are missing (service accounts), so a path always resolves.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.MODA_CONFIG_DIR) return env.MODA_CONFIG_DIR;
  const xdg = nonEmpty(env.XDG_CONFIG_HOME);
  if (xdg !== undefined) return join(xdg, 'moda');
  if (platform === 'win32') {
    const appData = nonEmpty(env.APPDATA);
    if (appData !== undefined) return join(appData, 'moda');
  }
  return join(homedir(), '.config', 'moda');
}

export function stateDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.MODA_STATE_DIR) return env.MODA_STATE_DIR;
  const xdg = nonEmpty(env.XDG_STATE_HOME);
  if (xdg !== undefined) return join(xdg, 'moda');
  if (platform === 'win32') {
    const localAppData = nonEmpty(env.LOCALAPPDATA);
    if (localAppData !== undefined) return join(localAppData, 'moda');
  }
  return join(homedir(), '.local', 'state', 'moda');
}

export function configFilePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(configDir(env, platform), 'config.toml');
}

export function credentialsFilePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(configDir(env, platform), 'credentials.json');
}
