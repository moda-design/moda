/**
 * Bun compile matrix (cli-repo-plan §1.3). Usage:
 *
 *   bun scripts/build.ts                    # the whole release matrix (standalone channel)
 *   bun scripts/build.ts --host             # host platform only → dist/moda-host
 *   bun scripts/build.ts --only win32-x64   # one target, by its <platform>-<arch> slug
 *   bun scripts/build.ts --channel npm      # channel stamp override
 *
 * Windows x64 cross-compiles from the same Linux runner (`bun-windows-x64`, verified on the
 * pinned bun 1.3.14). Its artifact carries the `.exe` suffix Windows needs to execute it, so
 * the name is not a plain `moda-<platform>-<arch>` — release.ts and package-npm.ts and
 * `packages/moda/bin/moda.js` all carry the suffixed form.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const ENTRY = join(ROOT, 'cli', 'src', 'main.ts');
const DIST = join(ROOT, 'dist');

interface Target {
  bunTarget: string;
  artifact: string;
}

const TARGETS: Target[] = [
  { bunTarget: 'bun-darwin-arm64', artifact: 'moda-darwin-arm64' },
  { bunTarget: 'bun-darwin-x64', artifact: 'moda-darwin-x64' },
  { bunTarget: 'bun-linux-x64', artifact: 'moda-linux-x64' },
  { bunTarget: 'bun-linux-arm64', artifact: 'moda-linux-arm64' },
  { bunTarget: 'bun-windows-x64', artifact: 'moda-win32-x64.exe' },
];

async function readVersion(): Promise<string> {
  const pkg = (await Bun.file(join(ROOT, 'cli', 'package.json')).json()) as { version: string };
  return pkg.version;
}

/**
 * The `--host` artifact name. Windows will not execute a suffix-less file and bun appends `.exe`
 * there whether or not we ask, so name it up front. prove-stub.ts carries the same literal — this
 * module runs a build on import, so it cannot be imported for the constant.
 */
const hostArtifact = (platform: NodeJS.Platform = process.platform): string =>
  platform === 'win32' ? 'moda-host.exe' : 'moda-host';

async function build(target: Target | undefined, version: string, channel: string): Promise<void> {
  const outfile = target === undefined ? join(DIST, hostArtifact()) : join(DIST, target.artifact);
  const argv = [
    'bun',
    'build',
    '--compile',
    '--minify',
    ...(target !== undefined ? [`--target=${target.bunTarget}`] : []),
    '--define',
    `MODA_BUILD_VERSION="${version}"`,
    '--define',
    `MODA_BUILD_CHANNEL="${channel}"`,
    ENTRY,
    '--outfile',
    outfile,
  ];
  console.error(`build: ${target?.artifact ?? 'host'} (${version}, ${channel})`);
  const proc = Bun.spawn(argv, { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`build failed for ${target?.artifact ?? 'host'} (exit ${code})`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const hostOnly = args.includes('--host');
const channelIdx = args.indexOf('--channel');
const channel = channelIdx >= 0 ? (args[channelIdx + 1] ?? 'standalone') : 'standalone';
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;

// `--only <slug>` matches the artifact's <platform>-<arch>, suffix or not (`win32-x64`).
const selected = only === undefined ? TARGETS : TARGETS.filter((t) => t.artifact.replace(/^moda-|\.exe$/g, '') === only);
if (only !== undefined && selected.length === 0) {
  console.error(`unknown --only target '${only}' — known: ${TARGETS.map((t) => t.artifact).join(', ')}`);
  process.exit(2);
}

mkdirSync(DIST, { recursive: true });
const version = await readVersion();
if (hostOnly) {
  await build(undefined, version, channel);
} else {
  for (const target of selected) await build(target, version, channel);
}
console.error('build: done');
