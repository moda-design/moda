/**
 * Credential storage without native modules (cli.md §2.4, cli-repo-plan §2.7): shell out to
 * OS keychain CLIs, with a chmod-600 JSON file fallback. Service name `moda-cli`; account is
 * `<api_base_host>/<org_id>` so dev/prod and multi-org credentials coexist.
 *
 * Every keychain subprocess gets a hard timeout (locked keyrings hang) and falls back cleanly.
 * MODA_KEYCHAIN=file forces the fallback (tests, headless boxes).
 *
 * Windows has NO shell-out backend, on purpose: Credential Manager's CLI (`cmdkey`) can write
 * and list credentials but never prints a stored secret back, so it cannot serve a read path —
 * a real backend there means DPAPI/CredRead, i.e. FFI or a PowerShell crypto shim. Windows
 * therefore uses the file backend, whose protection is the user-profile ACL rather than a mode
 * bit; `writeAll` says exactly that instead of claiming 0600.
 */
import { chmodSync, mkdirSync, openSync, closeSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { CliError } from '../cliError.ts';
import { credentialsFilePath } from '../config/paths.ts';

export const KEYCHAIN_SERVICE = 'moda-cli';
const SUBPROCESS_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 2_000;

export interface StoredCredential {
  key: string;
  org: string;
  scopes: string[];
  created_at: string;
  api_base: string;
}

export interface KeychainBackend {
  readonly name: 'macos-keychain' | 'linux-secret-tool' | 'file';
  store(account: string, secret: StoredCredential): Promise<void>;
  read(account: string): Promise<StoredCredential | undefined>;
  delete(account: string): Promise<boolean>;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function exec(
  argv: string[],
  opts: { stdin?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? SUBPROCESS_TIMEOUT_MS;
  const proc = Bun.spawn(argv, {
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: (opts.env ?? process.env) as Record<string, string | undefined>,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGKILL');
  }, timeoutMs);
  const code = await proc.exited;
  clearTimeout(timer);
  // A killed shim's grandchildren can hold the pipes open — never block on stream close.
  const graceText = (stream: ReadableStream<Uint8Array>): Promise<string> =>
    Promise.race([
      new Response(stream).text(),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 250)),
    ]);
  const [stdout, stderr] = await Promise.all([graceText(proc.stdout), graceText(proc.stderr)]);
  return { code, stdout, stderr, timedOut };
}

/** POSIX-only probe — only the darwin/linux branches of selectKeychainBackend reach it. */
async function commandExists(name: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const result = await exec(['/bin/sh', '-c', `command -v ${name}`], { timeoutMs: PROBE_TIMEOUT_MS, env });
  return result.code === 0 && !result.timedOut;
}

// --- macOS: /usr/bin/security. Secret via execFile argv (no shell) — accepted tradeoff per plan. ---

function securityBin(env: NodeJS.ProcessEnv): string {
  // Overridable so tests can substitute a shim; production resolves the OS binary.
  return env.MODA_SECURITY_BIN ?? '/usr/bin/security';
}

class MacKeychain implements KeychainBackend {
  readonly name = 'macos-keychain' as const;
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  async store(account: string, secret: StoredCredential): Promise<void> {
    const result = await exec([
      securityBin(this.env),
      'add-generic-password',
      '-U',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      account,
      '-w',
      JSON.stringify(secret),
    ]);
    if (result.code !== 0 || result.timedOut) {
      throw CliError.internal(`macOS keychain store failed (exit ${result.code}${result.timedOut ? ', timed out' : ''}).`);
    }
  }

  async read(account: string): Promise<StoredCredential | undefined> {
    const result = await exec([
      securityBin(this.env),
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      account,
      '-w',
    ]);
    if (result.code !== 0 || result.timedOut) return undefined;
    return parseSecret(result.stdout.trim());
  }

  async delete(account: string): Promise<boolean> {
    const result = await exec([securityBin(this.env), 'delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account]);
    return result.code === 0 && !result.timedOut;
  }
}

// --- Linux: secret-tool (libsecret). Secret via stdin, never argv. ---

class SecretToolKeychain implements KeychainBackend {
  readonly name = 'linux-secret-tool' as const;

  async store(account: string, secret: StoredCredential): Promise<void> {
    const result = await exec(
      ['secret-tool', 'store', '--label=moda-cli', 'service', KEYCHAIN_SERVICE, 'account', account],
      { stdin: JSON.stringify(secret) },
    );
    if (result.code !== 0 || result.timedOut) {
      throw CliError.internal(`secret-tool store failed (exit ${result.code}${result.timedOut ? ', timed out' : ''}).`);
    }
  }

  async read(account: string): Promise<StoredCredential | undefined> {
    const result = await exec(['secret-tool', 'lookup', 'service', KEYCHAIN_SERVICE, 'account', account]);
    if (result.code !== 0 || result.timedOut) return undefined;
    return parseSecret(result.stdout.trim());
  }

  async delete(account: string): Promise<boolean> {
    const result = await exec(['secret-tool', 'clear', 'service', KEYCHAIN_SERVICE, 'account', account]);
    return result.code === 0 && !result.timedOut;
  }
}

// --- Fallback: ~/.config/moda/credentials.json, 0600, one-time stderr warning. ---

type CredentialsFile = Record<string, StoredCredential>;

export class FileKeychain implements KeychainBackend {
  readonly name = 'file' as const;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private warned = false;

  constructor(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) {
    this.env = env;
    this.platform = platform;
  }

  private path(): string {
    return credentialsFilePath(this.env, this.platform);
  }

  private readAll(): CredentialsFile {
    try {
      return JSON.parse(readFileSync(this.path(), 'utf8')) as CredentialsFile;
    } catch {
      return {};
    }
  }

  private writeAll(all: CredentialsFile): void {
    const path = this.path();
    mkdirSync(dirname(path), { recursive: true });
    // O_CREAT|O_WRONLY|O_TRUNC with 0600, then verify the mode (an existing file keeps its mode).
    const fd = openSync(path, 'w', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(all, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    // Windows has no POSIX mode bits — node's chmod only toggles the read-only flag there, so
    // enforcing 0600 would be a no-op that reads like a guarantee. Skip it and say so instead.
    if (this.platform !== 'win32') {
      const mode = statSync(path).mode & 0o777;
      if (mode !== 0o600) chmodSync(path, 0o600);
    }
    if (!this.warned) {
      this.warned = true;
      const protection =
        this.platform === 'win32' ? 'protected by your Windows user-profile ACL, not a mode bit' : 'mode 0600';
      process.stderr.write(`moda: no OS keychain available — credential stored in ${path} (${protection}).\n`);
    }
  }

  async store(account: string, secret: StoredCredential): Promise<void> {
    const all = this.readAll();
    all[account] = secret;
    this.writeAll(all);
  }

  async read(account: string): Promise<StoredCredential | undefined> {
    return this.readAll()[account];
  }

  async delete(account: string): Promise<boolean> {
    const all = this.readAll();
    if (!(account in all)) return false;
    delete all[account];
    const path = this.path();
    if (Object.keys(all).length === 0) {
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
      return true;
    }
    this.writeAll(all);
    return true;
  }
}

function parseSecret(raw: string): StoredCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredCredential>;
    if (typeof parsed.key !== 'string' || typeof parsed.org !== 'string') return undefined;
    return {
      key: parsed.key,
      org: parsed.org,
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes.filter((s): s is string => typeof s === 'string') : [],
      created_at: typeof parsed.created_at === 'string' ? parsed.created_at : '',
      api_base: typeof parsed.api_base === 'string' ? parsed.api_base : '',
    };
  } catch {
    return undefined;
  }
}

/** Pick the backend for this host: OS keychain when the probe passes, file fallback otherwise. */
export async function selectKeychainBackend(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<KeychainBackend> {
  if (env.MODA_KEYCHAIN === 'file') return new FileKeychain(env, platform);
  if (env.MODA_KEYCHAIN === 'macos') return new MacKeychain(env);
  if (env.MODA_KEYCHAIN === 'secret-tool') return new SecretToolKeychain();
  if (platform === 'darwin') {
    if (await commandExists('security', env)) return new MacKeychain(env);
    return new FileKeychain(env, platform);
  }
  if (platform === 'linux') {
    if (!(await commandExists('secret-tool', env))) return new FileKeychain(env, platform);
    if (env.DBUS_SESSION_BUS_ADDRESS === undefined || env.DBUS_SESSION_BUS_ADDRESS === '') {
      return new FileKeychain(env, platform);
    }
    // Probe must not hang (headless boxes with locked keyrings do) — 2s timeout ⇒ fallback.
    const probe = await exec(['secret-tool', 'search', 'service', KEYCHAIN_SERVICE], {
      timeoutMs: PROBE_TIMEOUT_MS,
      env,
    });
    if (probe.timedOut) return new FileKeychain(env, platform);
    return new SecretToolKeychain();
  }
  // Windows and every other platform: the file backend (see the module header for why Windows
  // has no shell-out backend). No POSIX probe runs here — `commandExists` shells out to /bin/sh.
  return new FileKeychain(env, platform);
}

export function keychainAccount(apiBase: string, org: string): string {
  return `${new URL(apiBase).host}/${org}`;
}
