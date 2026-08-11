/**
 * Effective context resolution (cli.md §2.3, cli-repo-plan §2.6), implemented once and
 * unit-tested. Precedence: explicit flag > env (MODA_ORG, MODA_API_BASE) >
 * .moda/context.local.json > .moda/context.json > config.toml > built-in default.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';
import { CliError } from '../cliError.ts';
import { readConfig } from './config.ts';

export const DEFAULT_API_BASE = 'https://api.moda.app';

export type ContextSource = 'flag' | 'env' | 'context.local' | 'context' | 'config' | 'default' | 'unset';

export interface ResolvedValue {
  value: string | undefined;
  source: ContextSource;
}

export interface RepoContext {
  org?: string;
  brand?: string;
  canvas?: string;
}

export interface ContextFlags {
  org?: string;
  apiBase?: string;
}

export interface EffectiveContext {
  org: ResolvedValue;
  brand: ResolvedValue;
  canvas: ResolvedValue;
  apiBase: ResolvedValue & { value: string };
  outputDir: ResolvedValue;
  /** Directory holding the .moda/ context files, when one was found by the walk-up. */
  repoRoot?: string;
}

interface RepoContextFiles {
  root?: string;
  committed: RepoContext;
  local: RepoContext;
}

function readJsonIfExists(path: string): RepoContext {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const obj = parsed as Record<string, unknown>;
    const pick = (k: string) => (typeof obj[k] === 'string' ? (obj[k] as string) : undefined);
    return { org: pick('org'), brand: pick('brand'), canvas: pick('canvas') };
  } catch {
    return {};
  }
}

/** Walk up from cwd looking for a `.moda/` directory with context files. */
export function findRepoContext(cwd: string = process.cwd()): RepoContextFiles {
  let dir = cwd;
  const stop = parsePath(dir).root;
  for (;;) {
    const modaDir = join(dir, '.moda');
    const committedPath = join(modaDir, 'context.json');
    const localPath = join(modaDir, 'context.local.json');
    if (existsSync(committedPath) || existsSync(localPath)) {
      return { root: dir, committed: readJsonIfExists(committedPath), local: readJsonIfExists(localPath) };
    }
    if (dir === stop) return { committed: {}, local: {} };
    dir = dirname(dir);
  }
}

function resolveKey(
  flag: string | undefined,
  env: string | undefined,
  local: string | undefined,
  committed: string | undefined,
  config: string | undefined,
): ResolvedValue {
  if (flag !== undefined) return { value: flag, source: 'flag' };
  if (env !== undefined && env !== '') return { value: env, source: 'env' };
  if (local !== undefined) return { value: local, source: 'context.local' };
  if (committed !== undefined) return { value: committed, source: 'context' };
  if (config !== undefined) return { value: config, source: 'config' };
  return { value: undefined, source: 'unset' };
}

export function resolveContext(
  flags: ContextFlags = {},
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): EffectiveContext {
  const config = readConfig(env);
  const repo = findRepoContext(cwd);

  const org = resolveKey(flags.org, env.MODA_ORG, repo.local.org, repo.committed.org, config.context?.org);
  const brand = resolveKey(undefined, undefined, repo.local.brand, repo.committed.brand, config.defaults?.brand);
  const canvas = resolveKey(undefined, undefined, repo.local.canvas, repo.committed.canvas, undefined);
  const apiBaseResolved = resolveKey(flags.apiBase, env.MODA_API_BASE, undefined, undefined, config.api_base);
  const apiBase: ResolvedValue & { value: string } =
    apiBaseResolved.value !== undefined
      ? { value: apiBaseResolved.value, source: apiBaseResolved.source }
      : { value: DEFAULT_API_BASE, source: 'default' };
  const outputDir = resolveKey(undefined, undefined, undefined, undefined, config.defaults?.output_dir);

  return { org, brand, canvas, apiBase, outputDir, repoRoot: repo.root };
}

const CONTEXT_KEYS = ['org', 'brand', 'canvas'] as const;
export type ContextKey = (typeof CONTEXT_KEYS)[number];

export function assertContextKey(key: string): ContextKey {
  if ((CONTEXT_KEYS as readonly string[]).includes(key)) return key as ContextKey;
  throw CliError.usage(`Unknown context key '${key}'.`, `Valid keys: ${CONTEXT_KEYS.join(', ')}.`);
}

/**
 * Write a repo-context value. `--local` writes .moda/context.local.json and appends it to
 * .gitignore when missing (cli.md §2.3).
 */
export function writeRepoContextKey(
  key: ContextKey,
  value: string | undefined,
  opts: { local: boolean },
  cwd: string = process.cwd(),
): string {
  const repo = findRepoContext(cwd);
  const root = repo.root ?? cwd;
  const modaDir = join(root, '.moda');
  mkdirSync(modaDir, { recursive: true });
  const fileName = opts.local ? 'context.local.json' : 'context.json';
  const path = join(modaDir, fileName);
  const current = opts.local ? repo.local : repo.committed;
  const next: RepoContext = { ...current };
  if (value === undefined) delete next[key];
  else next[key] = value;
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  if (opts.local) ensureGitignored(root, '.moda/context.local.json');
  return path;
}

function ensureGitignored(root: string, entry: string): void {
  const gitignore = join(root, '.gitignore');
  let existing = '';
  try {
    existing = readFileSync(gitignore, 'utf8');
  } catch {
    // no .gitignore yet
  }
  if (existing.split('\n').some((line) => line.trim() === entry)) return;
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(gitignore, `${prefix}${entry}\n`, 'utf8');
}
