/**
 * Browser key-mint login flow (cli-repo-plan §3; rulings 2 and 10): ephemeral 127.0.0.1
 * listener, opaque state nonce, constant-time state check, immediate whoami validation, then
 * keychain storage. `--paste` covers headless; `MODA_API_KEY` covers CI without any verb.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import { CliError } from '../cliError.ts';
import { readConfig } from '../config/config.ts';
import { MINT_PAGE_PATH } from '../api/endpoints.ts';

export function generateState(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time state comparison; sha256 both sides so lengths always match. */
export function stateMatches(expected: string, received: string): boolean {
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(received).digest();
  return timingSafeEqual(a, b);
}

/** Web-app base for the mint page: MODA_APP_BASE > config app_base > derived from api_base. */
export function resolveAppBase(apiBase: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.MODA_APP_BASE !== undefined && env.MODA_APP_BASE !== '') return env.MODA_APP_BASE;
  const configured = readConfig(env).app_base;
  if (configured !== undefined) return configured;
  const url = new URL(apiBase);
  if (url.hostname.startsWith('api.')) {
    url.hostname = url.hostname.slice('api.'.length);
    return url.origin;
  }
  return url.origin;
}

export function mintUrl(appBase: string, state: string, port: number | undefined, scopes: string[] | undefined): string {
  const url = new URL(MINT_PAGE_PATH, appBase);
  url.searchParams.set('state', state);
  if (port !== undefined) url.searchParams.set('port', String(port));
  if (scopes !== undefined && scopes.length > 0) url.searchParams.set('scopes', scopes.join(','));
  url.searchParams.set('name', `moda-cli on ${hostname()}`);
  return url.toString();
}

const SUCCESS_HTML = `<!doctype html><meta charset="utf-8"><title>moda — logged in</title>
<body style="font-family: system-ui, sans-serif; display: grid; place-items: center; height: 100vh; margin: 0">
<div style="text-align: center"><h1>Logged in</h1><p>Return to your terminal — you can close this tab.</p></div>
</body>`;

export interface ListenerResult {
  key: string;
}

export interface ListenerHandle {
  port: number;
  /** Resolves when the callback delivers a valid key; rejects on timeout or state mismatch. */
  result: Promise<ListenerResult>;
  close(): void;
}

/**
 * Start the loopback listener. Routes: `GET /callback?state=…&key=…` (constant-time state
 * check; mismatch ⇒ 400 and a typed CLI error), anything else ⇒ 404.
 */
export function startLoginListener(state: string, timeoutMs: number): ListenerHandle {
  let resolveResult: (r: ListenerResult) => void;
  let rejectResult: (e: unknown) => void;
  const result = new Promise<ListenerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  let settled = false;
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request: Request): Response {
      const url = new URL(request.url);
      if (url.pathname !== '/callback') return new Response('Not found', { status: 404 });
      const receivedState = url.searchParams.get('state') ?? '';
      const key = url.searchParams.get('key') ?? '';
      if (!stateMatches(state, receivedState)) {
        // Reject on the next tick so the 400 response flushes to the browser before the
        // process exits on the typed error.
        setTimeout(
          () =>
            settle(() =>
              rejectResult(
                new CliError({
                  type: 'authentication',
                  code: 'state_mismatch',
                  message: 'Login callback state did not match — possible interference. Nothing was stored.',
                  hint: 'Re-run `moda auth login`.',
                  source: 'local',
                }),
              ),
            ),
          100,
        );
        return new Response('State mismatch', { status: 400 });
      }
      if (key.length === 0) return new Response('Missing key', { status: 400 });
      // Hold the key in memory only. Resolve on a short delay so the success page flushes to
      // the browser BEFORE the CLI proceeds (and possibly exits); force-stop shortly after.
      setTimeout(() => settle(() => resolveResult({ key })), 150);
      setTimeout(() => server.stop(true), 400);
      return new Response(SUCCESS_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    },
  });

  const timer = setTimeout(() => {
    server.stop(true);
    settle(() =>
      rejectResult(
        new CliError({
          type: 'authentication',
          code: 'login_timeout',
          message: 'Timed out waiting for the browser login (5 minutes).',
          hint: 'Re-run `moda auth login`, or use `moda auth login --paste` / MODA_API_KEY on headless machines.',
          source: 'local',
        }),
      ),
    );
  }, timeoutMs);
  // Detached observer: clear the timer either way, and swallow ITS OWN rejection copy so the
  // caller's `await result` is the only surviving rejection path.
  result.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  );

  return {
    port: server.port ?? 0,
    result,
    close: () => {
      clearTimeout(timer);
      // Graceful: let any in-flight response (the success page) finish flushing.
      server.stop();
    },
  };
}

/**
 * Open the browser: MODA_BROWSER (a command; '-' means print-only) > `open` (macOS) >
 * `xdg-open` (Linux). Failure is non-fatal — the URL is always printed to stderr.
 */
export async function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const custom = env.MODA_BROWSER;
  if (custom === '-') return false;
  const candidates = custom !== undefined && custom !== ''
    ? [custom]
    : process.platform === 'darwin'
      ? ['open']
      : ['xdg-open'];
  for (const opener of candidates) {
    try {
      const proc = Bun.spawn([opener, url], { stdout: 'ignore', stderr: 'ignore' });
      // Do not wait for the browser to exit; just confirm the spawn didn't fail immediately.
      setTimeout(() => proc.unref(), 0);
      return true;
    } catch {
      // try next candidate
    }
  }
  return false;
}

/** Hidden-echo stdin read for `--paste`. */
export async function readKeyFromStdin(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const value = await readHidden();
  process.stderr.write('\n');
  return value.trim();
}

async function readHidden(): Promise<string> {
  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  let buffer = '';
  return new Promise<string>((resolve) => {
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          stdin.off('data', onData);
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.pause();
          resolve(buffer);
          return;
        }
        if (ch === '\u0003') {
          // Ctrl-C in raw mode
          if (stdin.isTTY) stdin.setRawMode(false);
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') buffer = buffer.slice(0, -1);
        else buffer += ch;
      }
    };
    stdin.on('data', onData);
  });
}
