/**
 * `$XDG_STATE_HOME/moda/` — non-config, non-secret state: per-canvas revision cache,
 * update-check stamp, screenshot default landing dir, credential-account index.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDir } from './paths.ts';

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// --- Revision cache (cli.md §9 staleness sugar; cli-repo-plan §2.6) ---

export interface RevisionEntry {
  revision: string;
  /** Short session ids (`n7`, `p_a`, `img1`) seen in the last read, for the stderr staleness warning. */
  short_ids: string[];
  read_at: string;
}

type RevisionCache = Record<string, RevisionEntry>;

function revisionsPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), 'revisions.json');
}

export function readRevisionEntry(canvasKey: string, env: NodeJS.ProcessEnv = process.env): RevisionEntry | undefined {
  return readJson<RevisionCache>(revisionsPath(env), {})[canvasKey];
}

export function writeRevisionEntry(canvasKey: string, entry: RevisionEntry, env: NodeJS.ProcessEnv = process.env): void {
  const cache = readJson<RevisionCache>(revisionsPath(env), {});
  cache[canvasKey] = entry;
  writeJson(revisionsPath(env), cache);
}

export function updateRevisionOnly(canvasKey: string, revision: string, env: NodeJS.ProcessEnv = process.env): void {
  const cache = readJson<RevisionCache>(revisionsPath(env), {});
  const prior = cache[canvasKey];
  cache[canvasKey] = { revision, short_ids: prior?.short_ids ?? [], read_at: new Date().toISOString() };
  writeJson(revisionsPath(env), cache);
}

// --- Update stamp (cli.md §14) ---

export interface UpdateStamp {
  latest?: string;
  minimum_supported?: string;
  seen_at?: string;
  last_notice_at?: string;
  last_notice_version?: string;
}

function updateStampPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), 'update-stamp.json');
}

export function readUpdateStamp(env: NodeJS.ProcessEnv = process.env): UpdateStamp {
  return readJson<UpdateStamp>(updateStampPath(env), {});
}

export function writeUpdateStamp(stamp: UpdateStamp, env: NodeJS.ProcessEnv = process.env): void {
  writeJson(updateStampPath(env), stamp);
}

// --- Screenshot landing dir ---

export function shotsDir(canvasRef: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), 'shots', canvasRef);
}

// --- Credential-account index (non-secret; lets `auth status` find the account without an org flag) ---

export interface AccountIndexEntry {
  host: string;
  org: string;
}

function accountsPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), 'accounts.json');
}

export function readAccountIndex(env: NodeJS.ProcessEnv = process.env): AccountIndexEntry[] {
  return readJson<AccountIndexEntry[]>(accountsPath(env), []);
}

export function upsertAccountIndex(entry: AccountIndexEntry, env: NodeJS.ProcessEnv = process.env): void {
  const entries = readAccountIndex(env).filter((e) => !(e.host === entry.host && e.org === entry.org));
  entries.push(entry);
  writeJson(accountsPath(env), entries);
}

export function removeAccountIndex(entry: AccountIndexEntry, env: NodeJS.ProcessEnv = process.env): void {
  writeJson(
    accountsPath(env),
    readAccountIndex(env).filter((e) => !(e.host === entry.host && e.org === entry.org)),
  );
}
