# Security

## Reporting a vulnerability

Please report security issues privately — **do not open a public issue.**

- Preferred: [open a private security advisory](https://github.com/moda-design/moda/security/advisories/new)
  on this repo.
- Or email **security@moda.app**.

Include what you found, how to reproduce it, and what an attacker could do
with it. We will acknowledge your report and keep you posted on the fix. If
you would like credit in the advisory, say so and we will name you.

Please give us a reasonable window to ship a fix before disclosing publicly,
and avoid accessing or modifying data that is not yours while testing.

## Scope

This repo holds the `moda` CLI and the agent skills that drive it. Relevant
here:

- credential handling in the CLI (`moda auth login`, OS keychain storage,
  the `MODA_API_KEY` path);
- anything that would cause the CLI or a skill to leak a key, a token, or a
  signed URL into output, logs, or a committed file;
- the release/distribution path (binaries, checksums, npm packages).

Vulnerabilities in the Moda service itself (the API, the web app, hosted
`*.moda.page` sites) are in scope for the same contacts above — say which
surface you are reporting on.

## What the CLI does with your credentials

- `moda auth login` mints a scoped key in the browser and stores it in the OS
  keychain (macOS Keychain, or `secret-tool` on Linux). With no keychain
  available it falls back to a `0600` file and says so.
- No CLI verb ever prints a credential, and signed URLs are redacted in
  output.
- The skills are written to never ask for, print, or handle a key.

If you find a path that breaks any of those three, we want to hear about it.
