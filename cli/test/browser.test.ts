/**
 * The shared browser launcher: per-platform argv (pure, unit-testable) and the print-only /
 * failure contract. The win32 branch is deliberately shell-free (`rundll32
 * url.dll,FileProtocolHandler`) — `cmd /c start` re-parses its command line and would split a
 * server-provided URL on & | ^ metacharacters.
 */
import { describe, expect, test } from 'bun:test';
import { browserArgv, openBrowser } from '../src/browser.ts';

const URL = 'https://moda.app/canvas/018f3c6e-1234-4abc-9def-00112233aabb?a=1&b=2';

describe('browserArgv', () => {
  test('MODA_BROWSER=- means print-only (no argv)', () => {
    expect(browserArgv(URL, { MODA_BROWSER: '-' }, 'linux')).toBeUndefined();
  });

  test('MODA_BROWSER names a custom launcher on any platform', () => {
    expect(browserArgv(URL, { MODA_BROWSER: 'firefox' }, 'darwin')).toEqual(['firefox', URL]);
    // Empty string is "unset", not a launcher.
    expect(browserArgv(URL, { MODA_BROWSER: '' }, 'linux')).toEqual(['xdg-open', URL]);
  });

  test('platform defaults: macOS open, Windows rundll32 (shell-free), everything else xdg-open', () => {
    expect(browserArgv(URL, {}, 'darwin')).toEqual(['open', URL]);
    expect(browserArgv(URL, {}, 'win32')).toEqual(['rundll32', 'url.dll,FileProtocolHandler', URL]);
    expect(browserArgv(URL, {}, 'linux')).toEqual(['xdg-open', URL]);
    expect(browserArgv(URL, {}, 'freebsd')).toEqual(['xdg-open', URL]);
  });

  test('the win32 argv never routes the URL through cmd (metachar-splitting hole)', () => {
    const argv = browserArgv(URL, {}, 'win32') as string[];
    expect(argv[0]).not.toBe('cmd');
    expect(argv).toContain(URL); // the URL rides as ONE argv element, unparsed
  });
});

describe('openBrowser', () => {
  test('print-only override returns false without spawning', async () => {
    expect(await openBrowser(URL, { MODA_BROWSER: '-' })).toBe(false);
  });

  test('a missing launcher command returns false instead of throwing', async () => {
    expect(await openBrowser(URL, { MODA_BROWSER: '/nonexistent/launcher-xyz' })).toBe(false);
  });

  test('a spawnable launcher returns true', async () => {
    // `true` exists on every POSIX CI runner; the contract is "spawned", not "browser appeared".
    expect(await openBrowser(URL, { MODA_BROWSER: 'true' })).toBe(true);
  });
});
