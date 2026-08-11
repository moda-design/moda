/** XDG path resolution (cli.md §2.3). MODA_CONFIG_DIR overrides the config dir wholesale. */
import { homedir } from 'node:os';
import { join } from 'node:path';

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MODA_CONFIG_DIR) return env.MODA_CONFIG_DIR;
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), '.config'), 'moda');
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MODA_STATE_DIR) return env.MODA_STATE_DIR;
  const xdg = env.XDG_STATE_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'state'), 'moda');
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'config.toml');
}

export function credentialsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'credentials.json');
}
