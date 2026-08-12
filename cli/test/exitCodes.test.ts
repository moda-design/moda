import { describe, expect, test } from 'bun:test';
import {
  EXIT_AUTH,
  EXIT_CONFLICT,
  EXIT_INTERNAL,
  EXIT_INVALID_INPUT,
  EXIT_NOT_FOUND,
  EXIT_OK,
  EXIT_QUOTA,
  EXIT_TRANSPORT,
  exitCodeForError,
  exitCodeForSuccess,
} from '../src/output/exitCodes.ts';
import type { CliErrorFields } from '../src/cliError.ts';

function api(type: string, code = 'x'): CliErrorFields {
  return { type, code, message: 'm', source: 'api' };
}

describe('exit-code mapper (cli.md §4.1)', () => {
  test('success always exits 0 — including requires_repair and skipped > 0', () => {
    expect(exitCodeForSuccess({ committed: true })).toBe(EXIT_OK);
    expect(exitCodeForSuccess({ committed: true, requiresRepair: true })).toBe(EXIT_OK);
    expect(exitCodeForSuccess({ committed: true, skipped: 3 })).toBe(EXIT_OK);
  });

  // Every ErrorType member of the server's closed enum (backend/app/api/public/errors.py:42).
  const typeRows: Array<[string, number]> = [
    ['invalid_request', EXIT_INVALID_INPUT],
    ['unprocessable', EXIT_INVALID_INPUT],
    ['authentication', EXIT_AUTH],
    ['permission', EXIT_AUTH],
    ['not_found', EXIT_NOT_FOUND],
    ['conflict', EXIT_CONFLICT],
    ['idempotency_conflict', EXIT_CONFLICT],
    ['rate_limited', EXIT_QUOTA],
    ['upstream_error', EXIT_TRANSPORT],
    ['internal_error', EXIT_TRANSPORT],
  ];
  for (const [type, exit] of typeRows) {
    test(`api type ${type} → exit ${exit}`, () => {
      expect(exitCodeForError(api(type))).toBe(exit);
    });
  }

  const codeRows: Array<[string, string]> = [
    ['invalid_request', 'invalid_markup'],
    ['invalid_request', 'invalid_edit_program'],
    ['unprocessable', 'missing_assets'],
  ];
  for (const [type, code] of codeRows) {
    test(`${type}/${code} → exit 2`, () => {
      expect(exitCodeForError(api(type, code))).toBe(EXIT_INVALID_INPUT);
    });
  }

  test('permission/insufficient_scope and entitlement_required → exit 3', () => {
    expect(exitCodeForError(api('permission', 'insufficient_scope'))).toBe(EXIT_AUTH);
    expect(exitCodeForError(api('permission', 'entitlement_required'))).toBe(EXIT_AUTH);
  });

  test('conflict codes (canvas_busy, stale_revision) → exit 5', () => {
    expect(exitCodeForError(api('conflict', 'canvas_busy'))).toBe(EXIT_CONFLICT);
    expect(exitCodeForError(api('conflict', 'stale_revision'))).toBe(EXIT_CONFLICT);
  });

  test('HTTP 402 billing refusal → exit 6 (live backend sends code invalid_request, so the status is the signal)', () => {
    expect(exitCodeForError({ ...api('invalid_request', 'invalid_request'), status: 402 })).toBe(EXIT_QUOTA);
  });

  test('426 cli_update_required stays on the invalid-input lane (exit 2), not quota', () => {
    expect(exitCodeForError({ ...api('invalid_request', 'cli_update_required'), status: 426 })).toBe(EXIT_INVALID_INPUT);
  });

  test('free_publishing_disabled (platform kill switch, typed permission/403) → exit 6, not the auth lane', () => {
    expect(exitCodeForError(api('permission', 'free_publishing_disabled'))).toBe(EXIT_QUOTA);
  });

  test('billing/quota codes → exit 6 regardless of type', () => {
    expect(exitCodeForError(api('permission', 'payment_required'))).toBe(EXIT_QUOTA);
    expect(exitCodeForError(api('invalid_request', 'insufficient_credits'))).toBe(EXIT_QUOTA);
    expect(exitCodeForError(api('permission', 'plan_limit_exceeded'))).toBe(EXIT_QUOTA);
    expect(exitCodeForError(api('rate_limited', 'fair_use_exceeded'))).toBe(EXIT_QUOTA);
  });

  test('transport errors → exit 7', () => {
    expect(exitCodeForError({ type: 'upstream_error', code: 'transport', message: 'm', source: 'transport' })).toBe(
      EXIT_TRANSPORT,
    );
  });

  test('local usage → 2, local auth → 3, local internal → 1, unknown api type → 1', () => {
    expect(exitCodeForError({ type: 'invalid_request', code: 'usage', message: 'm', source: 'local' })).toBe(
      EXIT_INVALID_INPUT,
    );
    expect(exitCodeForError({ type: 'authentication', code: 'no_credentials', message: 'm', source: 'local' })).toBe(
      EXIT_AUTH,
    );
    expect(exitCodeForError({ type: 'internal_error', code: 'cli_internal', message: 'm', source: 'local' })).toBe(
      EXIT_INTERNAL,
    );
    expect(exitCodeForError(api('someday_new_type'))).toBe(EXIT_INTERNAL);
  });
});
