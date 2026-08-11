/**
 * Build-time identity. `scripts/build.ts` injects MODA_BUILD_VERSION / MODA_BUILD_CHANNEL
 * via `bun build --compile --define`; under `bun test` / dev runs the fallbacks apply.
 */
declare const MODA_BUILD_VERSION: string;
declare const MODA_BUILD_CHANNEL: string;

export const CLI_VERSION: string = typeof MODA_BUILD_VERSION !== 'undefined' ? MODA_BUILD_VERSION : '0.1.0-dev';

/** Install channel: 'standalone' | 'npm' | 'brew' | 'dev'. Stamped at build time (cli.md §14). */
export const CLI_CHANNEL: string = typeof MODA_BUILD_CHANNEL !== 'undefined' ? MODA_BUILD_CHANNEL : 'dev';

export function platformArch(): string {
  return `${process.platform}-${process.arch}`;
}

export function userAgent(): string {
  return `moda-cli/${CLI_VERSION} (${CLI_CHANNEL}; ${platformArch()})`;
}
