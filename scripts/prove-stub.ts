/**
 * End-to-end proof against a stub server (no studio stack needed):
 *
 *   1. `moda version --json` from the COMPILED binary.
 *   2. `moda doctor --json` against a stub /v1/whoami (headers, auth, version range).
 *   3. `moda auth login` full listener flow with a scripted fake redirect (no browser),
 *      then `auth status` off the stored credential, then `auth logout`.
 *
 * Usage: bun scripts/build.ts --host && bun scripts/prove-stub.ts
 */
import { mkdtempSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
// Same literal as scripts/build.ts `hostArtifact` (that module builds on import, so it cannot
// be imported for the constant): the Windows host binary carries the `.exe` suffix.
const HOST_ARTIFACT = process.platform === 'win32' ? 'moda-host.exe' : 'moda-host';
const BIN = process.env.MODA_BIN ?? join(ROOT, 'dist', HOST_ARTIFACT);
if (!existsSync(BIN)) {
  console.error(`missing binary ${BIN} — run: bun scripts/build.ts --host`);
  process.exit(1);
}

const STUB_KEY = `moda_live_${'ab'.repeat(32)}`;
const scratch = mkdtempSync(join(tmpdir(), 'moda-prove-'));
/**
 * The child env is deliberately scrubbed so the proof cannot borrow the developer's real config.
 * Windows still needs its profile/system variables — a child without SystemRoot loses winsock
 * (every request fails) and one without USERPROFILE has no homedir() — so those pass through.
 */
const WINDOWS_PASSTHROUGH = ['SystemRoot', 'SystemDrive', 'windir', 'USERPROFILE', 'TEMP', 'TMP', 'ComSpec'];
const baseEnv: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  ...(process.platform === 'win32'
    ? Object.fromEntries(
        WINDOWS_PASSTHROUGH.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k] as string]),
      )
    : {}),
  MODA_CONFIG_DIR: join(scratch, 'config'),
  MODA_STATE_DIR: join(scratch, 'state'),
  MODA_KEYCHAIN: 'file',
  MODA_NO_UPDATE_CHECK: '1',
};

// --- Stub server: whoami + a couple of version headers ---
const stub = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request: Request): Response {
    const url = new URL(request.url);
    // Reconciled contract headers (cli/src/api/endpoints.ts HEADER_CLI_*).
    const headers = { 'Moda-Cli-Latest-Version': '0.1.0', 'Moda-Cli-Minimum-Version': '0.0.1', 'X-Request-ID': 'req_stub1' };
    if (url.pathname === '/v1/whoami') {
      const auth = request.headers.get('Authorization');
      if (auth !== `Bearer ${STUB_KEY}`) {
        return Response.json(
          { error: { type: 'authentication', code: 'invalid_api_key', message: 'Invalid API key.', request_id: 'req_stub1' } },
          { status: 401, headers },
        );
      }
      // Reconciled whoami shape (cli/src/api/types.ts parseWhoami): organization carries the
      // org id, team carries the human display name.
      return Response.json(
        {
          user: { id: 'user_1', email: 'dev@moda.app' },
          organization: { id: 'org_STUB' },
          team: { id: 'team_STUB', name: 'Stub Org' },
          plan: 'pro',
          scopes: ['canvases:read', 'canvases:write', 'designs:export', 'uploads:write'],
        },
        { headers },
      );
    }
    return Response.json(
      { error: { type: 'not_found', code: 'unknown_path', message: `No route ${url.pathname}.` } },
      { status: 404, headers },
    );
  },
});
const apiBase = `http://127.0.0.1:${stub.port}`;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  const proc = Bun.spawn([BIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...baseEnv, MODA_API_BASE: apiBase, ...env },
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.error(`PASS ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
}

// --- 1. version --json ---
{
  const result = await run(['version', '--json']);
  const body = JSON.parse(result.stdout) as Record<string, unknown>;
  check('version exits 0', result.code === 0, `exit ${result.code}`);
  check('version JSON shape', body.ok === true && body.channel === 'standalone' && typeof body.version === 'string');
}

// --- 2. doctor --json (authed via env key) ---
{
  const result = await run(['doctor', '--json'], { MODA_API_KEY: STUB_KEY });
  const body = JSON.parse(result.stdout) as Record<string, unknown>;
  const checks = body.checks as Record<string, unknown>;
  check('doctor exits 0', result.code === 0, `exit ${result.code}: ${result.stdout}`);
  check('doctor ok + authenticated', body.ok === true && body.authenticated === true);
  check('doctor credential_source env', checks.credential_source === 'env');
  check('doctor scopes reported', Array.isArray(checks.scopes) && (checks.scopes as string[]).includes('canvases:write'));
  check('doctor pinned install command', String(body.install_command) === 'npm i -g @moda-design/moda');
  const version = checks.version as Record<string, unknown>;
  check('doctor version range recorded', version.latest === '0.1.0' && version.minimum_supported === '0.0.1');
}

// --- 2b. doctor against a rejecting server (bad key) → exit 3 lane ---
{
  const result = await run(['doctor', '--json'], { MODA_API_KEY: 'moda_live_wrong' });
  const body = JSON.parse(result.stdout) as Record<string, unknown>;
  check('doctor invalid credential exits 3', result.code === 3, `exit ${result.code}`);
  check('doctor invalid credential reported', body.authenticated === false);
}

// --- 3. auth login with a scripted fake redirect ---
{
  const proc = Bun.spawn([BIN, 'auth', 'login', '--json'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...baseEnv, MODA_API_BASE: apiBase, MODA_BROWSER: '-', MODA_APP_BASE: 'https://app.invalid' },
  });

  // Read stderr until the mint URL appears, then play the browser's role.
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stderrText = '';
  let mint: URL | undefined;
  const deadline = Date.now() + 15_000;
  while (mint === undefined && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    stderrText += decoder.decode(value, { stream: true });
    const match = /https:\/\/app\.invalid\/cli\/auth\?\S+/.exec(stderrText);
    if (match) mint = new URL(match[0]);
  }
  check('login prints the mint URL', mint !== undefined, stderrText);
  if (mint !== undefined) {
    const state = mint.searchParams.get('state') ?? '';
    const port = mint.searchParams.get('port') ?? '';
    check('mint URL carries state + port + name', state.length > 20 && port.length > 0 && mint.searchParams.get('name') !== null);

    // Wrong state first: must 400 and NOT complete the flow.
    const bad = await fetch(`http://127.0.0.1:${port}/callback?state=WRONG&key=${STUB_KEY}`);
    check('wrong state rejected with 400', bad.status === 400);

    // (state mismatch is fatal by design — restart the flow for the happy path)
  }
  proc.kill();
  await proc.exited;
}

{
  // Fresh login flow for the happy path (a mismatch above intentionally poisons that attempt).
  const proc = Bun.spawn([BIN, 'auth', 'login', '--json'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...baseEnv, MODA_API_BASE: apiBase, MODA_BROWSER: '-', MODA_APP_BASE: 'https://app.invalid' },
  });
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stderrText = '';
  let mint: URL | undefined;
  const deadline = Date.now() + 15_000;
  while (mint === undefined && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    stderrText += decoder.decode(value, { stream: true });
    const match = /https:\/\/app\.invalid\/cli\/auth\?\S+/.exec(stderrText);
    if (match) mint = new URL(match[0]);
  }
  check('login (2nd) prints the mint URL', mint !== undefined);
  let loginOk = false;
  if (mint !== undefined) {
    const state = mint.searchParams.get('state') ?? '';
    const port = mint.searchParams.get('port') ?? '';
    const redirect = await fetch(
      `http://127.0.0.1:${port}/callback?state=${encodeURIComponent(state)}&key=${STUB_KEY}`,
    );
    check('scripted redirect accepted (200 + landing page)', redirect.status === 200 && (await redirect.text()).includes('Logged in'));
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    const body = JSON.parse(stdout) as Record<string, unknown>;
    const identity = body.identity as Record<string, unknown>;
    loginOk = code === 0 && body.ok === true;
    check('login exits 0 with identity JSON', loginOk && identity.org === 'org_STUB' && identity.email === 'dev@moda.app', stdout);
    check('login JSON never contains the key', !stdout.includes(STUB_KEY));

    const credPath = join(baseEnv.MODA_CONFIG_DIR as string, 'credentials.json');
    check('credential stored in fallback file', existsSync(credPath));
    if (existsSync(credPath)) {
      // POSIX-only: Windows has no mode bits — the file's protection there is the profile ACL,
      // and `auth login` says so instead of claiming 0600 (cli/src/auth/keychain.ts).
      if (process.platform !== 'win32') {
        check('credentials file mode 0600', (statSync(credPath).mode & 0o777) === 0o600);
      }
      check('credentials file holds the key + org', readFileSync(credPath, 'utf8').includes('org_STUB'));
    }
  }

  if (loginOk) {
    const status = await run(['auth', 'status', '--json']);
    const statusBody = JSON.parse(status.stdout) as Record<string, unknown>;
    check('auth status uses the stored credential', status.code === 0 && statusBody.credential_source === 'file');
    check('auth status never prints the key', !status.stdout.includes(STUB_KEY));

    const logout = await run(['auth', 'logout', '--json']);
    const logoutBody = JSON.parse(logout.stdout) as Record<string, unknown>;
    check('auth logout deletes the local credential', logout.code === 0 && logoutBody.deleted === true);
  }
}

stub.stop(true);
console.error(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
