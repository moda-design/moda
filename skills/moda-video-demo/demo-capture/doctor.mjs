#!/usr/bin/env node
// What is missing, said before anything is recorded.
//
// The pipeline shells out to four binaries and drives a browser, and until now
// every one of those was discovered as a stack trace partway through a capture
// — after discovery had spent model calls and the recorder had driven someone's
// app. `moda doctor` sets the precedent; this is the same idea for the parts
// that run on the user's machine.
//
// Reports three states per requirement, never two: present, missing, or
// UNKNOWN. A check that cannot run must not read as a pass — the failure this
// pipeline has re-learned five times.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { report } = require('./src/bin.js');

const OK = '  ok  ';
const NO = ' MISS ';
const HM = '  ?   ';
const rows = [];
const note = (state, what, detail) => rows.push({ state, what, detail });

// ── node ────────────────────────────────────────────────────────────────
const major = Number(process.versions.node.split('.')[0]);
note(major >= 20 ? OK : NO, 'node', `${process.versions.node}${major >= 20 ? '' : ' — needs 20 or newer'}`);

// ── ffmpeg / ffprobe ────────────────────────────────────────────────────
for (const [name, r] of Object.entries(report)) {
  note(r.from === 'missing' ? NO : OK, name,
    r.from === 'missing' ? `not on PATH and no ${name}-static installed` : `${r.from}${r.from === 'bundled' ? '' : ` (${r.path})`}`);
}

// ── the tool's own dependencies ─────────────────────────────────────────
// First on the list because everything below it fails confusingly without them,
// and the fix is one command run in one place.
const here = path.dirname(fileURLToPath(import.meta.url));
note(existsSync(path.join(here, 'node_modules')) ? OK : NO, 'dependencies',
  existsSync(path.join(here, 'node_modules')) ? here.replace(process.env.HOME ?? '~', '~')
    : `not installed — run: (cd ${here.replace(process.env.HOME ?? '~', '~')} && npm install)`);

// ── playwright, and the browser it needs ────────────────────────────────
let chromium = null;
try {
  ({ chromium } = require('playwright'));
  note(OK, 'playwright', require('playwright/package.json').version);
} catch {
  note(NO, 'playwright', 'not installed — npm install');
}
if (chromium) {
  const p = chromium.executablePath?.();
  note(p && existsSync(p) ? OK : NO, 'chromium',
    p && existsSync(p) ? p.replace(process.env.HOME ?? '~', '~') : 'not downloaded — npx playwright install chromium');
}

// ── the two CLIs ────────────────────────────────────────────────────────
for (const [bin, why] of [['moda', 'publishes the canvas and exports the mp4'], ['claude', 'writes the flow, the script and the critique']]) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  note(r.error ? NO : OK, bin, r.error ? `not on PATH — ${why}` : (r.stdout || '').trim().split('\n')[0].slice(0, 40));
}

// Authenticated is a different question from installed, and the failure looks
// nothing alike — an unauthenticated publish fails minutes in, after a capture.
//
// `moda auth status` is the command, and its EXIT CODE is not the answer: it
// exits 0 whether or not you are signed in, so keying on that reported "not
// signed in" while publishing worked all day. The JSON says `authenticated`.
const who = spawnSync('moda', ['auth', 'status', '--json'], { encoding: 'utf8' });
let auth = null;
try {
  const line = (who.stdout || '').split('\n').filter((l) => l.trim().startsWith('{')).pop();
  auth = line ? JSON.parse(line) : null;
} catch { /* unparseable */ }
note(who.error ? HM : auth?.authenticated ? OK : NO, 'moda auth',
  who.error ? 'could not ask (moda missing)'
    : auth?.authenticated ? `${auth.identity?.email ?? 'signed in'} · ${auth.identity?.org_name ?? ''}`.trim()
    : 'not signed in — moda auth login');

// ── optional: the camera lane ───────────────────────────────────────────
let studio = null;
try {
  const { studioPython } = require('./src/studio-path.js');
  const py = studioPython();
  studio = existsSync(py) ? py : null;
} catch { /* no checkout */ }
note(studio ? OK : HM, 'studio checkout',
  studio ? 'present — iterate can re-emit the camera locally' : 'absent — publishing still works; the loop\'s camera lane is off and zoom checks read "not measured"');

const width = Math.max(...rows.map((r) => r.what.length));
for (const r of rows) console.log(`[${r.state}] ${r.what.padEnd(width)}  ${r.detail}`);

const missing = rows.filter((r) => r.state === NO);
console.log(missing.length
  ? `\n${missing.length} thing(s) missing: ${missing.map((r) => r.what).join(', ')}`
  : '\nready.');
process.exit(missing.length ? 1 : 0);
