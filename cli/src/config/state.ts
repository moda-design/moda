/**
 * `$XDG_STATE_HOME/moda/` — non-config, non-secret state: per-canvas revision cache,
 * update-check stamp, screenshot default landing dir, credential-account index.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactValue } from '../output/redact.ts';
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

// --- Last error envelope (agent ergonomics: never re-run a failed write to see the error) ---

function lastErrorPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), 'last-error.json');
}

/**
 * Persist the --json error envelope of a nonzero exit. Best-effort — never throws. The
 * envelope is REDACTED before it touches disk (signed URLs, moda_live_ keys) and the file is
 * owner-only (0600): error bodies can quote request payloads and signed artifact URLs.
 */
export function persistLastError(doc: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const path = lastErrorPath(env);
    const redacted = redactValue({ ...doc, exited_at: new Date().toISOString() });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(redacted, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    // mode only applies on creation — enforce on pre-existing files too.
    chmodSync(path, 0o600);
  } catch {
    // State-dir problems must not mask the real error.
  }
}

/** Drop the recorded failure once a command succeeds — last-error always means the LAST run. */
export function clearLastError(env: NodeJS.ProcessEnv = process.env): void {
  try {
    rmSync(lastErrorPath(env), { force: true });
  } catch {
    // Best-effort.
  }
}

export function readLastError(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | undefined {
  const value = readJson<Record<string, unknown> | undefined>(lastErrorPath(env), undefined);
  return value !== undefined && typeof value === 'object' ? value : undefined;
}

// --- Task-start replay ledger (the server sends no replayed flag on task.start) ---

export interface TaskStartEntry {
  task_id: string;
  started_at: string;
  /** Terminal status when observed by --wait / task status (failed | succeeded | ...). */
  last_status?: string;
}

type TaskStartLedger = Record<string, TaskStartEntry>;

const TASK_LEDGER_CAP = 50;

function taskStartsPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), 'task-starts.json');
}

export function readTaskStart(key: string, env: NodeJS.ProcessEnv = process.env): TaskStartEntry | undefined {
  return readJson<TaskStartLedger>(taskStartsPath(env), {})[key];
}

export function recordTaskStart(key: string, entry: TaskStartEntry, env: NodeJS.ProcessEnv = process.env): void {
  const ledger = readJson<TaskStartLedger>(taskStartsPath(env), {});
  ledger[key] = entry;
  const keys = Object.keys(ledger);
  if (keys.length > TASK_LEDGER_CAP) {
    keys
      .sort((a, b) => (ledger[a]?.started_at ?? '').localeCompare(ledger[b]?.started_at ?? ''))
      .slice(0, keys.length - TASK_LEDGER_CAP)
      .forEach((k) => delete ledger[k]);
  }
  writeJson(taskStartsPath(env), ledger);
}

/** Note a task's terminal status on whichever ledger entry started it (best-effort). */
export function recordTaskStatus(taskId: string, status: string, env: NodeJS.ProcessEnv = process.env): void {
  const ledger = readJson<TaskStartLedger>(taskStartsPath(env), {});
  let changed = false;
  for (const entry of Object.values(ledger)) {
    if (entry.task_id === taskId && entry.last_status !== status) {
      entry.last_status = status;
      changed = true;
    }
  }
  if (changed) writeJson(taskStartsPath(env), ledger);
}

// --- Ask-session continuity (`moda ask`; server-minted `ask_<uuid>`) ---

/**
 * The last `moda ask` session id per account, so follow-up questions keep their context without
 * the caller threading an id. Keyed by the credential account (`host/org`) because the server
 * binds a session to the minting principal — a foreign id reads as nonexistent (404).
 *
 * Not a secret and not a config value: it is the same class of derived, discardable state as the
 * revision cache. Expiry is NOT mirrored here — the server owns the idle TTL and says so with a
 * typed 410; duplicating the window locally would only add a constant that can drift.
 */
export interface AskSessionEntry {
  session_id: string;
  updated_at: string;
}

type AskSessionStore = Record<string, AskSessionEntry>;

/** Bounded like the task ledger — a long-lived state dir must not grow one entry per account forever. */
const ASK_SESSION_CAP = 20;

function askSessionsPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), 'ask-sessions.json');
}

export function readAskSession(accountKey: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const entry = readJson<AskSessionStore>(askSessionsPath(env), {})[accountKey];
  return typeof entry?.session_id === 'string' && entry.session_id.length > 0 ? entry.session_id : undefined;
}

export function writeAskSession(accountKey: string, sessionId: string, env: NodeJS.ProcessEnv = process.env): void {
  const store = readJson<AskSessionStore>(askSessionsPath(env), {});
  store[accountKey] = { session_id: sessionId, updated_at: new Date().toISOString() };
  const keys = Object.keys(store);
  if (keys.length > ASK_SESSION_CAP) {
    keys
      .sort((a, b) => (store[a]?.updated_at ?? '').localeCompare(store[b]?.updated_at ?? ''))
      .slice(0, keys.length - ASK_SESSION_CAP)
      .forEach((k) => delete store[k]);
  }
  writeJson(askSessionsPath(env), store);
}

export function clearAskSession(accountKey: string, env: NodeJS.ProcessEnv = process.env): void {
  const store = readJson<AskSessionStore>(askSessionsPath(env), {});
  if (store[accountKey] === undefined) return;
  delete store[accountKey];
  writeJson(askSessionsPath(env), store);
}
