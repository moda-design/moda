// Auth for the capture browser.
//
// The failure this module exists to prevent is silent. Cookies are origin-scoped,
// so a storage state minted for `https://moda.app` contributes NOTHING to a
// context pointed at `http://localhost:3000` — Playwright does not complain, the
// page loads, and the recording is of a signed-out app. That footage is a
// perfectly valid mp4 of the wrong thing, and every downstream stage (converge,
// compile, publish) succeeds on it. So origin agreement is asserted here rather
// than discovered by watching the output.
import { createRequire } from 'node:module';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const PROD_STATE = 'auth.json';

/** Local targets get a freshly minted session; anything else uses the saved one. */
function isLocal(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.test') ||
    hostname.endsWith('.local')
  );
}

function originsIn(statePath) {
  const doc = JSON.parse(readFileSync(statePath, 'utf8'));
  const fromOrigins = (doc.origins ?? []).map((o) => o.origin);
  // Cookie domains matter more than localStorage origins: the Clerk `__session`
  // cookie is what the app actually reads.
  const fromCookies = (doc.cookies ?? []).map((c) => c.domain.replace(/^\./, ''));
  return { fromOrigins, fromCookies };
}

/**
 * Does this storage state carry a session that the target origin will send?
 *
 * Host-suffix rather than equality: a `.moda.app` cookie is sent to `moda.app`
 * AND `app.moda.app`, and a localhost state's cookies are portless.
 */
function stateCovers(statePath, target) {
  const { fromOrigins, fromCookies } = originsIn(statePath);
  const host = target.hostname;
  return (
    fromOrigins.some((o) => new URL(o).hostname === host) ||
    fromCookies.some((d) => host === d || host.endsWith(`.${d}`))
  );
}

/**
 * Mint a session against a locally-served studio, using studio's OWN zero-touch
 * Clerk setup rather than a second implementation of the ticket flow.
 *
 * Reusing it is the point: the setup project signs in through Clerk's Backend
 * API, then PROVES the backend accepts the result with a direct authenticated
 * `GET /users/me` before saving. A hand-rolled sign-in here would skip that
 * proof and hand capture a cookie the backend rejects — signed in on the client,
 * empty on every API call, which records as a logged-in shell with no data.
 */
function mintLocalState(studioDir, target, { maxAgeMin = 45 } = {}) {
  const statePath = path.join(studioDir, 'e2e', 'agent-auth', '.auth', 'test-user.json');
  const fresh =
    existsSync(statePath) && (Date.now() - statSync(statePath).mtimeMs) / 60000 < maxAgeMin;
  if (fresh) return statePath;

  // The azp trap: the setup project asserts a localhost port in 3000-3005,
  // because Clerk rejects the token's authorized-party otherwise. Failing here
  // with the real reason beats an opaque sync failure two stages later.
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  if (isLocal(target.hostname) && (port < 3000 || port > 3005)) {
    throw new Error(
      `serve the app on port 3000-3005 for local auth (got ${port}). Clerk rejects the ` +
        `token's authorized party outside that range, and studio's setup asserts it up front.`
    );
  }

  // studio's OWN playwright, by path. `npx playwright` resolves the binary from
  // the npx cache instead, and that copy cannot import `@playwright/test` from
  // studio's node_modules — it dies on the config file before running anything.
  const pw = path.join(studioDir, 'node_modules', '.bin', 'playwright');
  if (!existsSync(pw)) throw new Error(`no playwright in ${studioDir} — run npm install there first.`);

  // Doppler's config is bound to a DIRECTORY, and it is bound to the main
  // checkout, not to worktrees: `doppler run` inside one fails with "You must
  // specify a config". The env vars are doppler's own, and they travel.
  const env = {
    ...process.env,
    AGENT_AUTH_BASE_URL: target.origin,
    DOPPLER_PROJECT: process.env.DOPPLER_PROJECT ?? 'studio',
    DOPPLER_CONFIG: process.env.DOPPLER_CONFIG ?? 'local_personal',
    // Deliberately NOT in Doppler — docs/guides/agent-e2e-playbook.md says to
    // pass it on the command line, and every other e2e harness in the repo
    // spells this same address. The ticket strategy needs only this plus
    // CLERK_SECRET_KEY, so there is no password to hold anywhere.
    E2E_CLERK_TEST_EMAIL: process.env.E2E_CLERK_TEST_EMAIL ?? 'claude+clerk_test@nullframe.ai',
  };

  try {
    execFileSync(
      'doppler',
      ['run', '--', pw, 'test', '-c', 'e2e/agent-auth/playwright.config.ts', '--project=setup'],
      { cwd: studioDir, stdio: 'pipe', env, timeout: 180_000 }
    );
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
    throw new Error(
      `local sign-in failed (doppler ${env.DOPPLER_PROJECT}/${env.DOPPLER_CONFIG}). studio's setup ` +
        `needs E2E_CLERK_TEST_EMAIL and CLERK_SECRET_KEY, and the app served at ${target.origin}.\n` +
        `${out.slice(-1500)}`
    );
  }
  if (!existsSync(statePath)) throw new Error(`sign-in reported success but wrote no state at ${statePath}`);
  return statePath;
}

/**
 * The storage state capture and converge should both use. Returns its path.
 *
 * Both callers must go through this: the reset that makes capture authoritative
 * is a fresh CONTEXT, and a fresh context with the wrong session is exactly as
 * wrong as a dirty one.
 */
const { studioRoot } = createRequire(import.meta.url)('./src/studio-path.js');

export function resolveStorageState(url, { studioDir } = {}) {
  const target = new URL(url);

  // NOT EVERY TARGET IS MODA. This is a demo generator for "a feature you just
  // shipped", and plenty of apps — including the one it was first pointed at
  // outside studio — have no sign-in at all. Assuming otherwise made a local
  // target fail with a Clerk port assertion for an app that has no Clerk:
  //
  //   serve the app on port 3000-3005 for local auth (got 3007)
  //
  // `DEMO_NO_AUTH=1` records signed-out. It is opt-in rather than inferred,
  // because guessing wrong in the other direction is the expensive mistake: a
  // signed-out recording of an app that DOES have auth is a valid-looking video
  // of the login wall, which is the failure the origin check below exists for.
  if (process.env.DEMO_NO_AUTH === '1') {
    return { path: undefined, source: 'no auth (DEMO_NO_AUTH=1)' };
  }

  if (isLocal(target.hostname)) {
    // One resolver — see src/studio-path.js. Three copies of this lookup existed
    // and fixing one left the others reading a `.studio` file that no longer has
    // to exist.
    let dir = studioDir ?? null;
    if (!dir) { try { dir = studioRoot(); } catch { dir = null; } }
    if (!dir) {
      throw new Error(
        'a local target needs a studio checkout to sign in against — put its path in `.studio` ' +
          'or pass --studio <path>.'
      );
    }
    const statePath = mintLocalState(dir, target);
    return { path: statePath, source: `minted against ${target.origin}` };
  }

  if (!existsSync(PROD_STATE)) {
    throw new Error(`no saved session at ${PROD_STATE} for ${target.origin}.`);
  }
  if (!stateCovers(PROD_STATE, target)) {
    const { fromOrigins } = originsIn(PROD_STATE);
    throw new Error(
      `${PROD_STATE} holds a session for ${fromOrigins.join(', ') || 'an unknown origin'}, not ` +
        `${target.origin}. Cookies are origin-scoped, so using it here would record a SIGNED-OUT ` +
        `app — a valid-looking video of the wrong thing.`
    );
  }
  return { path: PROD_STATE, source: `saved session for ${target.origin}` };
}
