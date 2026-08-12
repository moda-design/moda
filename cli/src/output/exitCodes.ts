/**
 * The cli.md §4.1 exit-code contract, table-driven and pure.
 *
 * Invariant: exit 0 means the operation COMMITTED — including committed-but-imperfect
 * (`requires_repair: true`, `operation_counts.skipped > 0`). Nonzero is reserved for
 * did-not-commit, which is what makes harness "retry on nonzero" loops safe.
 */
import type { CliErrorFields } from '../cliError.ts';

export const EXIT_OK = 0;
export const EXIT_INTERNAL = 1;
export const EXIT_INVALID_INPUT = 2;
export const EXIT_AUTH = 3;
export const EXIT_NOT_FOUND = 4;
export const EXIT_CONFLICT = 5;
export const EXIT_QUOTA = 6;
export const EXIT_TRANSPORT = 7;
export const EXIT_SIGINT = 130;

/**
 * Codes that mean "payment/quota" regardless of their ErrorType, per cli.md §4.1 row 6
 * (billing precheck, plan caps). `entitlement_required` stays exit 3 (permission row).
 *
 * NOTE: the live backend surfaces billing refusals as **HTTP 402 with code
 * `invalid_request`** (tasks/media routers raise HTTPException(402); the public app's
 * status→code map has no 402 entry, so the generic 4xx fallback code applies). The
 * status check below is therefore the primary quota signal; these codes are kept for
 * any future typed billing codes.
 */
const QUOTA_CODES: ReadonlySet<string> = new Set([
  'payment_required',
  'insufficient_credits',
  'credit_precheck_failed',
  'quota_exceeded',
  'plan_limit_exceeded',
  'slide_limit_exceeded',
  'concurrency_limit_exceeded',
]);

/** ErrorType (server closed enum, `backend/app/api/public/errors.py:42`) → exit code. */
const TYPE_TABLE: Readonly<Record<string, number>> = {
  invalid_request: EXIT_INVALID_INPUT,
  unprocessable: EXIT_INVALID_INPUT,
  authentication: EXIT_AUTH,
  permission: EXIT_AUTH,
  not_found: EXIT_NOT_FOUND,
  conflict: EXIT_CONFLICT,
  idempotency_conflict: EXIT_CONFLICT,
  rate_limited: EXIT_QUOTA,
  upstream_error: EXIT_TRANSPORT,
  internal_error: EXIT_TRANSPORT,
};

export function exitCodeForError(err: CliErrorFields): number {
  if (err.source === 'transport') return EXIT_TRANSPORT;
  if (err.source === 'local') {
    // Local kinds reuse the same type vocabulary; internal_error is the CLI's own bug lane.
    if (err.type === 'internal_error') return EXIT_INTERNAL;
    return TYPE_TABLE[err.type] ?? EXIT_INTERNAL;
  }
  // HTTP 402 Payment Required is the billing-refusal status on the live backend
  // (code arrives as the generic `invalid_request`) — key on the status, not the code.
  if (err.status === 402) return EXIT_QUOTA;
  if (QUOTA_CODES.has(err.code)) return EXIT_QUOTA;
  // Per-code override: the platform-wide publish kill switch arrives typed `permission`
  // (403), but exit 3 would send harnesses into a pointless `moda auth login` loop — it is
  // a wait/retry condition, not an auth problem, so it takes the quota/limits exit class.
  if (err.code === 'free_publishing_disabled') return EXIT_QUOTA;
  return TYPE_TABLE[err.type] ?? EXIT_INTERNAL;
}

export interface SuccessShape {
  committed?: boolean;
  requiresRepair?: boolean;
  skipped?: number;
}

/** Success always exits 0: committed-but-imperfect is a success by contract. */
export function exitCodeForSuccess(_shape: SuccessShape): number {
  return EXIT_OK;
}
