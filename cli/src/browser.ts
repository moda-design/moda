/**
 * Cross-platform browser launch — the one shared helper behind `auth login` and every
 * `<noun> open` verb. `MODA_BROWSER` overrides the launcher (a command name; the literal `-`
 * means print-only); otherwise macOS `open`, Windows `start` (a cmd builtin, hence `cmd /c`),
 * anything else `xdg-open`. Deliberately NO headless heuristics (DISPLAY/SSH_TTY sniffing):
 * launch failure is non-fatal by contract — callers print the URL and continue; a browser
 * that cannot spawn never fails the command.
 */
export async function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const custom = env.MODA_BROWSER;
  if (custom === '-') return false;
  const argv: string[] =
    custom !== undefined && custom !== ''
      ? [custom, url]
      : process.platform === 'darwin'
        ? ['open', url]
        : process.platform === 'win32'
          ? ['cmd', '/c', 'start', '', url] // '' fills start's window-title slot so the URL is not eaten by it
          : ['xdg-open', url];
  try {
    const proc = Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore' });
    // Do not wait for the browser to exit; just confirm the spawn didn't fail immediately.
    setTimeout(() => proc.unref(), 0);
    return true;
  } catch {
    return false;
  }
}
