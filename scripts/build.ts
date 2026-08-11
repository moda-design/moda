/**
 * Bun compile matrix (cli-repo-plan §1.3). Usage:
 *
 *   bun scripts/build.ts                # all four targets (standalone channel)
 *   bun scripts/build.ts --host         # host platform only → dist/moda-host
 *   bun scripts/build.ts --channel npm  # channel stamp override
 *
 * Windows x64 is deliberately deferred (plan §1.3); its artifact name is reserved.
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
];

async function readVersion(): Promise<string> {
  const pkg = (await Bun.file(join(ROOT, 'cli', 'package.json')).json()) as { version: string };
  return pkg.version;
}

async function build(target: Target | undefined, version: string, channel: string): Promise<void> {
  const outfile =
    target === undefined ? join(DIST, 'moda-host') : join(DIST, target.artifact);
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

mkdirSync(DIST, { recursive: true });
const version = await readVersion();
if (hostOnly) {
  await build(undefined, version, channel);
} else {
  for (const target of TARGETS) await build(target, version, channel);
}
console.error('build: done');
