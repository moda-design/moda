/**
 * Cross-platform browser launch — the one shared helper behind `auth login` and every
 * `<noun> open` verb. `MODA_BROWSER` overrides the launcher (a command name; the literal `-`
 * means print-only); otherwise macOS `open`, Windows `rundll32 url.dll,FileProtocolHandler`
 * (shell-free on purpose — `cmd /c start` re-parses the command line, splitting URLs on
 * & | ^ metacharacters), anything else `xdg-open`. Deliberately NO headless heuristics
 * (DISPLAY/SSH_TTY sniffing): launch failure is non-fatal by contract — callers print the
 * URL and continue; a browser that cannot spawn never fails the command.
 */

/** The launcher argv for this platform, or undefined for print-only (`MODA_BROWSER=-`). */
export function browserArgv(
  url: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] | undefined {
  const custom = env.MODA_BROWSER;
  if (custom === '-') return undefined;
  if (custom !== undefined && custom !== '') return [custom, url];
  if (platform === 'darwin') return ['open', url];
  if (platform === 'win32') return ['rundll32', 'url.dll,FileProtocolHandler', url];
  return ['xdg-open', url];
}

/** True when the launcher SPAWNED — not proof a window appeared; callers print the URL regardless. */
export async function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const argv = browserArgv(url, env);
  if (argv === undefined) return false;
  try {
    const proc = Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore' });
    // Do not wait for the browser to exit; just confirm the spawn didn't fail immediately.
    setTimeout(() => proc.unref(), 0);
    return true;
  } catch {
    return false;
  }
}
