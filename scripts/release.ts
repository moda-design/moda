/**
 * Release assembly (cli-repo-plan §1.4): checksums + GitHub Release upload. Run by
 * release.yml on a v<semver> tag; runnable locally with `gh auth` for a dry run
 * (`--dry-run` skips the gh call). Signing/attestation is a pre-publish gate, not dogfood.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');

const ARTIFACTS = ['moda-darwin-arm64', 'moda-darwin-x64', 'moda-linux-x64', 'moda-linux-arm64'];

const tag = process.argv[2];
if (tag === undefined || !/^v\d+\.\d+\.\d+/.test(tag)) {
  console.error('usage: bun scripts/release.ts v<semver> [--dry-run]');
  process.exit(2);
}
const dryRun = process.argv.includes('--dry-run');

const present = ARTIFACTS.filter((name) => existsSync(join(DIST, name)));
if (present.length === 0) {
  console.error('no artifacts in dist/ — run: bun scripts/build.ts');
  process.exit(1);
}

// SHA256SUMS in `sha256sum` format so `sha256sum -c SHA256SUMS` verifies downloads.
const lines: string[] = [];
for (const name of present) {
  const bytes = new Uint8Array(await Bun.file(join(DIST, name)).arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  lines.push(`${digest}  ${name}`);
}
writeFileSync(join(DIST, 'SHA256SUMS'), `${lines.join('\n')}\n`, 'utf8');
console.error(`SHA256SUMS written (${present.length} artifacts)`);

const npmTarballs = readdirSync(DIST).filter((f) => f.endsWith('.tgz'));
const assets = [...present, 'SHA256SUMS', ...npmTarballs].map((name) => join(DIST, name));

if (dryRun) {
  console.error(`dry run — would upload: ${assets.join(', ')}`);
  process.exit(0);
}

const proc = Bun.spawn(
  ['gh', 'release', 'create', tag, ...assets, '--title', `moda ${tag}`, '--notes', `moda CLI ${tag} (dogfood; private repo — install via \`gh release download\`)`],
  { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' },
);
process.exit(await proc.exited);
