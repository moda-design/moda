/**
 * CI parity check (skills-and-distribution §3.5): `moda __inventory` must match the committed
 * snapshot `cli/verb-inventory.json`. Regenerate deliberately with:
 *
 *   bun scripts/inventory-check.ts --update
 *
 * The skills slice (M5) diffs this same inventory against the skills mapping table.
 */
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const SNAPSHOT = join(ROOT, 'cli', 'verb-inventory.json');

const proc = Bun.spawn(['bun', join(ROOT, 'cli', 'src', 'main.ts'), '__inventory'], {
  cwd: ROOT,
  stdout: 'pipe',
  stderr: 'inherit',
});
const stdout = await new Response(proc.stdout).text();
const code = await proc.exited;
if (code !== 0) {
  console.error(`__inventory exited ${code}`);
  process.exit(1);
}
const current = JSON.stringify(JSON.parse(stdout), null, 2) + '\n';

if (process.argv.includes('--update')) {
  await Bun.write(SNAPSHOT, current);
  console.error(`inventory snapshot updated: ${SNAPSHOT}`);
  process.exit(0);
}

const snapshotFile = Bun.file(SNAPSHOT);
if (!(await snapshotFile.exists())) {
  console.error(`missing ${SNAPSHOT} — run: bun scripts/inventory-check.ts --update`);
  process.exit(1);
}
const committed = await snapshotFile.text();
if (committed !== current) {
  console.error('verb inventory drifted from cli/verb-inventory.json.');
  console.error('If the change is intentional: bun scripts/inventory-check.ts --update (and update the skills mapping).');
  process.exit(1);
}
console.error('inventory: in sync');
