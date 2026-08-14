#!/usr/bin/env node
// Biome-style platform-package resolver shim — no postinstall, no downloads (cli-repo-plan §1.2).
const { execFileSync } = require('node:child_process');
const pkg = `@moda-design/cli-${process.platform}-${process.arch}`;
// Windows will not execute a suffix-less file; scripts/package-npm.ts ships `bin/moda.exe` there.
const binName = process.platform === 'win32' ? 'moda.exe' : 'moda';
let bin;
try {
  bin = require.resolve(`${pkg}/bin/${binName}`);
} catch {
  console.error(
    `moda: platform binary ${pkg} is not installed.\n` +
      `Reinstall with optional dependencies enabled (npm i -g @moda-design/moda), or download the ` +
      `standalone binary from GitHub Releases (moda-design/moda).`,
  );
  process.exit(1);
}
try {
  execFileSync(bin, process.argv.slice(2), { stdio: 'inherit' });
} catch (e) {
  process.exit(e.status ?? 1);
}
