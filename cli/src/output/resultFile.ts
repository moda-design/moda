/**
 * `--output FILE` big-result routing: the full payload goes to a file (compact JSON), the
 * stdout envelope stays small — summary fields, a path, and a bounded preview — so large
 * results never flood an agent's context. Inspect the file with jq/grep.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CliError } from '../cliError.ts';
import { redactValue } from './redact.ts';

/** Bounded-preview sizes (the whole point is context frugality — keep these small). */
export const PREVIEW_CHARS = 500;
export const PREVIEW_ITEMS = 3;

export function writeResultFile(
  path: string,
  payload: unknown,
  opts: { failHint?: string } = {},
): { output: string; bytes: number } {
  const text = `${JSON.stringify(redactValue(payload))}\n`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
  } catch (err) {
    // io lane (exit 2, same as readFileArg's pattern) — not an internal crash: the API call
    // itself succeeded; only the local write failed.
    const detail = err instanceof Error ? err.message : String(err);
    throw CliError.io(
      `Cannot write --output file '${path}': ${detail}`,
      opts.failHint ?? 'Check the path and directory permissions, then re-run.',
    );
  }
  return { output: path, bytes: Buffer.byteLength(text, 'utf8') };
}

/** First ~PREVIEW_CHARS of a text field, with an ellipsis marker when truncated. Cuts on code
 *  points (Array.from), never through a surrogate pair. */
export function previewText(text: string): string {
  const chars = Array.from(text);
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join('')}…` : text;
}
