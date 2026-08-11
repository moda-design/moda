/**
 * Version-header capture, the once-daily stderr notice, and the dogfood update channel
 * (cli.md §14; orchestrator ruling 13: while the repo is private, `moda update` prints the
 * pinned `gh release download` command instead of self-updating).
 */
import { HEADER_CLI_LATEST, HEADER_CLI_MINIMUM } from './api/endpoints.ts';
import { readUpdateStamp, writeUpdateStamp } from './config/state.ts';
import { CLI_VERSION, platformArch } from './version.ts';

export const RELEASES_REPO = 'moda-design/moda';

export function pinnedInstallCommand(): string {
  return (
    `gh release download --repo ${RELEASES_REPO} -p moda-${platformArch()} -O ~/.local/bin/moda` +
    ' && chmod +x ~/.local/bin/moda'
  );
}

/** Compare two semver-ish strings. Returns <0, 0, >0. Non-numeric tags compare as 0-padded. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, '').split('-')[0]!.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // A prerelease (has a dash) sorts before the same release version.
  const aPre = a.includes('-') ? 1 : 0;
  const bPre = b.includes('-') ? 1 : 0;
  return bPre - aPre;
}

/** Record `Moda-Cli-Latest-Version` / `Moda-Cli-Minimum-Version` off an API response. */
export function recordVersionHeaders(headers: Headers, env: NodeJS.ProcessEnv = process.env): void {
  const latest = headers.get(HEADER_CLI_LATEST);
  const minimum = headers.get(HEADER_CLI_MINIMUM);
  if (latest === null && minimum === null) return;
  const stamp = readUpdateStamp(env);
  writeUpdateStamp(
    {
      ...stamp,
      ...(latest !== null ? { latest } : {}),
      ...(minimum !== null ? { minimum_supported: minimum } : {}),
      seen_at: new Date().toISOString(),
    },
    env,
  );
}

export function updateAvailable(env: NodeJS.ProcessEnv = process.env): { latest: string } | undefined {
  const stamp = readUpdateStamp(env);
  if (stamp.latest === undefined) return undefined;
  return compareVersions(stamp.latest, CLI_VERSION) > 0 ? { latest: stamp.latest } : undefined;
}

/**
 * The stderr notice: one dim line, at most once per day per version, never on stdout, never
 * in --json bodies. MODA_NO_UPDATE_CHECK=1 disables. Returns the notice line (for tests) or
 * undefined when suppressed.
 */
export function maybeUpdateNotice(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): string | undefined {
  if (env.MODA_NO_UPDATE_CHECK === '1') return undefined;
  const available = updateAvailable(env);
  if (available === undefined) return undefined;
  const stamp = readUpdateStamp(env);
  if (stamp.last_notice_version === available.latest && stamp.last_notice_at !== undefined) {
    const last = Date.parse(stamp.last_notice_at);
    if (Number.isFinite(last) && now.getTime() - last < 24 * 60 * 60 * 1000) return undefined;
  }
  writeUpdateStamp({ ...stamp, last_notice_at: now.toISOString(), last_notice_version: available.latest }, env);
  return `moda ${available.latest} is available (current: ${CLI_VERSION}). Run: moda update`;
}

export function emitUpdateNotice(env: NodeJS.ProcessEnv = process.env): void {
  const line = maybeUpdateNotice(env);
  if (line !== undefined) process.stderr.write(`\x1b[2m${line}\x1b[0m\n`);
}
