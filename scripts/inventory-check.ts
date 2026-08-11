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

// --- Skill-text flag audit (agent ergonomics item: the `--node` class of ghost flags) ---
// Every `--flag` token inside a `moda …` invocation in skill/shared/command text must exist in
// the verb inventory (any verb) or the global flag set. Catches references teaching flags the
// CLI does not have.
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';

const GLOBAL_FLAGS = new Set([
  '--json', '--pretty', '--quiet', '--no-input', '--no-retry', '--org', '--api-base', '--timeout',
  '--help', '--version', '--yes',
]);

const inventoryFlags = new Set<string>(GLOBAL_FLAGS);
for (const verb of JSON.parse(current).verbs as Array<{ flags: Array<{ flag: string }> }>) {
  for (const entry of verb.flags) inventoryFlags.add(entry.flag);
}

function* walkMarkdown(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkMarkdown(full);
    else if (entry.endsWith('.md')) yield full;
  }
}

/**
 * moda-invocation text spans: inline backtick spans containing `moda `, plus fenced blocks
 * with a moda line. Deliberately heuristic: continuation lines of a wrapped command inside a
 * fence are covered because the WHOLE fenced block is scanned once any line starts with moda;
 * prose flags outside moda spans are ignored by construction.
 */
function modaSpans(text: string): string[] {
  const spans: string[] = [];
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    // Require a verb after `moda` — bare mentions inside OTHER commands (e.g. the pinned
    // `gh release download … -O ~/.local/bin/moda && chmod …` install line) are not CLI spans.
    if (/\bmoda\s+[a-z]/.test(match[1] as string)) spans.push(match[1] as string);
  }
  const fences = text.split(/^(?:```|~~~).*$/m);
  for (let i = 1; i < fences.length; i += 2) {
    const block = fences[i] as string;
    if (/^\s*moda\s+[a-z]/m.test(block)) spans.push(block);
  }
  return spans;
}

const ghostFindings: string[] = [];
for (const dir of ['skills', 'shared', 'commands']) {
  const full = join(ROOT, dir);
  if (!existsSync(full)) continue;
  let files: string[] = [];
  try {
    files = [...walkMarkdown(full)];
  } catch (err) {
    // An unreadable tree must FAIL the audit, not silently shrink its coverage.
    console.error(`skill-text flag audit FAILED — cannot read ${dir}/: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const span of modaSpans(text)) {
      for (const match of span.matchAll(/(--[a-z][a-z-]+)/g)) {
        const flag = match[1] as string;
        if (!inventoryFlags.has(flag)) {
          ghostFindings.push(`${file.replace(`${ROOT}/`, '')}: flag ${flag} not in the verb inventory`);
        }
      }
    }
  }
}
if (ghostFindings.length > 0) {
  console.error(`skill-text flag audit FAILED — ${ghostFindings.length} ghost flag reference(s):`);
  for (const finding of [...new Set(ghostFindings)]) console.error(`  - ${finding}`);
  process.exit(1);
}
console.error('skill-text flag audit: clean');
