/**
 * The only writer to stdout. Rules (cli.md §3): under --json, stdout carries exactly one
 * JSON document per invocation; progress/warnings/prose go to stderr; binary payloads never
 * touch stdout unless `-o -` (then the JSON summary moves to stderr).
 */
import type { CliErrorFields } from '../cliError.ts';
import { CLI_VERSION } from '../version.ts';
import { redactString, redactValue } from './redact.ts';

export interface EmitOptions {
  json: boolean;
  quiet: boolean;
  /** When true (binary payload on stdout via `-o -`), the JSON document moves to stderr. */
  summaryToStderr?: boolean;
}

export type HumanRenderer = (write: (line: string) => void) => void;

export interface CommandOutcome {
  /** The --json document (pre-redaction; emit redacts). */
  body: Record<string, unknown>;
  /** Human rendering; defaults to a compact summary of `body`. */
  human?: HumanRenderer;
  exitCode: number;
  /** Binary payload went to stdout (`-o -`): move the JSON summary to stderr. */
  summaryToStderr?: boolean;
}

function writeStdout(text: string): void {
  process.stdout.write(text);
}

function writeStderr(text: string): void {
  process.stderr.write(text);
}

export function emitOutcome(outcome: CommandOutcome, opts: EmitOptions): void {
  if (opts.json) {
    const doc = `${JSON.stringify(redactValue(outcome.body), null, 2)}\n`;
    if (opts.summaryToStderr) writeStderr(doc);
    else writeStdout(doc);
    return;
  }
  const sink = opts.summaryToStderr ? writeStderr : writeStdout;
  const write = (line: string) => sink(`${redactString(line)}\n`);
  if (outcome.human) outcome.human(write);
  else defaultHuman(outcome.body, write);
}

function defaultHuman(body: Record<string, unknown>, write: (line: string) => void): void {
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || key === 'ok') continue;
    write(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
  }
}

export function errorBody(err: CliErrorFields): Record<string, unknown> {
  return {
    ok: false,
    error: {
      type: err.type,
      code: err.code,
      message: err.message,
      ...(err.hint !== undefined ? { hint: err.hint } : {}),
      ...(err.docUrl !== undefined ? { doc_url: err.docUrl } : {}),
      ...(err.requestId !== undefined ? { request_id: err.requestId } : {}),
      ...(err.retryable !== undefined ? { retryable: err.retryable } : {}),
      ...(err.retryAfterS !== undefined ? { retry_after_s: err.retryAfterS } : {}),
      ...(err.details !== undefined ? { details: err.details } : {}),
    },
  };
}

export function emitError(err: CliErrorFields, exitCode: number, opts: EmitOptions): void {
  if (opts.json) {
    writeStdout(`${JSON.stringify(redactValue(errorBody(err)), null, 2)}\n`);
    return;
  }
  const hint = err.hint ? `\n  hint: ${err.hint}` : '';
  const reqId = err.requestId ? ` (request ${err.requestId})` : '';
  writeStderr(redactString(`moda: error [${err.type}/${err.code}] ${err.message}${reqId}${hint}\n`));
  void exitCode;
}

/** Stderr-only progress/notice line; suppressed by --quiet. */
export function note(message: string, opts: { quiet: boolean }): void {
  if (opts.quiet) return;
  writeStderr(`${redactString(message)}\n`);
}
