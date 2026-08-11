/** `~/.config/moda/config.toml` read/write via smol-toml (cli.md §2.3). */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { CliError } from '../cliError.ts';
import { configFilePath } from './paths.ts';

export interface ModaConfig {
  api_base?: string;
  /** Web-app base for browser flows (mint page, `canvas open`). Defaults are derived from api_base. */
  app_base?: string;
  api_version?: string;
  context?: { org?: string };
  defaults?: { brand?: string; output_dir?: string };
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ModaConfig {
  let raw: string;
  try {
    raw = readFileSync(configFilePath(env), 'utf8');
  } catch {
    return {};
  }
  try {
    return parse(raw) as ModaConfig;
  } catch (err) {
    throw CliError.io(
      `Failed to parse ${configFilePath(env)}: ${err instanceof Error ? err.message : String(err)}`,
      'Fix or delete the file, then re-run.',
    );
  }
}

export function writeConfig(config: ModaConfig, env: NodeJS.ProcessEnv = process.env): void {
  const path = configFilePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stringify(config)}\n`, 'utf8');
}
