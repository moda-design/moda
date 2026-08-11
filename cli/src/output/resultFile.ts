/**
 * `--output FILE` big-result routing: the full payload goes to a file (compact JSON), the
 * stdout envelope stays small — summary fields, a path, and a bounded preview — so large
 * results never flood an agent's context. Inspect the file with jq/grep.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactValue } from './redact.ts';

/** Bounded-preview sizes (the whole point is context frugality — keep these small). */
export const PREVIEW_CHARS = 500;
export const PREVIEW_ITEMS = 3;

export function writeResultFile(path: string, payload: unknown): { output: string; bytes: number } {
  const text = `${JSON.stringify(redactValue(payload))}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return { output: path, bytes: Buffer.byteLength(text, 'utf8') };
}

/** First ~PREVIEW_CHARS of a text field, with an ellipsis marker when truncated. */
export function previewText(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}
