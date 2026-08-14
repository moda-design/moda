/**
 * Stamp versions and copy compiled binaries into the npm packages (cli-repo-plan §1.2).
 * Wrapper + platform packages always release as an exact-pinned set (the esbuild/biome
 * pattern). release.yml attaches `npm pack` output
 * to the GitHub Release instead.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');
const PACKAGES = join(ROOT, 'packages');

/**
 * `binName` is what lands in the platform package's `bin/` — Windows will not execute a file
 * without the `.exe` suffix, and `packages/moda/bin/moda.js` resolves the same suffixed name.
 * Keep it in step with the `files` array in each platform package.json.
 */
const PLATFORMS = [
  { pkg: 'cli-darwin-arm64', artifact: 'moda-darwin-arm64', binName: 'moda' },
  { pkg: 'cli-darwin-x64', artifact: 'moda-darwin-x64', binName: 'moda' },
  { pkg: 'cli-linux-x64', artifact: 'moda-linux-x64', binName: 'moda' },
  { pkg: 'cli-linux-arm64', artifact: 'moda-linux-arm64', binName: 'moda' },
  { pkg: 'cli-win32-x64', artifact: 'moda-win32-x64.exe', binName: 'moda.exe' },
];

const version = (JSON.parse(readFileSync(join(ROOT, 'cli', 'package.json'), 'utf8')) as { version: string }).version;

function stamp(path: string, mutate: (pkg: Record<string, unknown>) => void): void {
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  pkg.version = version;
  mutate(pkg);
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

// Wrapper: pin every optional dep to the identical version.
stamp(join(PACKAGES, 'moda', 'package.json'), (pkg) => {
  pkg.optionalDependencies = Object.fromEntries(PLATFORMS.map(({ pkg: name }) => [`@moda-design/${name}`, version]));
});

// Platform packages: version + binary payload.
let copied = 0;
for (const { pkg: name, artifact, binName } of PLATFORMS) {
  stamp(join(PACKAGES, name, 'package.json'), () => {});
  const source = join(DIST, artifact);
  if (existsSync(source)) {
    const binDir = join(PACKAGES, name, 'bin');
    mkdirSync(binDir, { recursive: true });
    const dest = join(binDir, binName);
    copyFileSync(source, dest);
    chmodSync(dest, 0o755);
    copied += 1;
  } else {
    console.error(`note: ${source} not built — ${name} stamped without a binary payload`);
  }
}
console.error(`package-npm: stamped ${PLATFORMS.length + 1} packages at ${version}; ${copied} binaries placed`);
