/** Server error envelope → typed CliError (backend/app/api/public/errors.py shape). */
import { CliError } from '../cliError.ts';

interface WireErrorEnvelope {
  type?: string;
  code?: string;
  message?: string;
  doc_url?: string;
  request_id?: string;
  retry_after_ms?: number;
  details?: Record<string, unknown>;
}

/**
 * 5xx codes that are terminal content failures, not server faults — retrying re-runs (and on
 * metered lanes re-bills) work that will fail the same way. 502 web_read_failed: the target
 * page could not be fetched (DNS, page error, timeout at the target).
 */
const NON_RETRYABLE_5XX_CODES = new Set(['web_read_failed']);

export function apiErrorFromResponse(
  status: number,
  body: unknown,
  requestId: string | undefined,
  /** Parsed `Retry-After` response header, seconds (canvas_busy/canvas_active_job send the header, not retry_after_ms). */
  retryAfterHeaderS?: number,
): CliError {
  const envelope = extractEnvelope(body);
  const retryAfterMs = envelope?.retry_after_ms;
  const type = envelope?.type ?? defaultTypeForStatus(status);
  const code = envelope?.code ?? `http_${status}`;
  return new CliError({
    type,
    code,
    message: envelope?.message ?? `API request failed with HTTP ${status}.`,
    source: 'api',
    // 426 cli_update_required is the server's contract floor — always name the fix.
    hint: status === 426 || code === 'cli_update_required' ? 'Run: moda update' : undefined,
    docUrl: envelope?.doc_url,
    requestId: envelope?.request_id ?? requestId,
    retryable:
      (type === 'rate_limited' || type === 'conflict' || status >= 500) && !NON_RETRYABLE_5XX_CODES.has(code),
    retryAfterS: retryAfterMs !== undefined ? Math.ceil(retryAfterMs / 1000) : retryAfterHeaderS,
    details: envelope?.details,
    status,
  });
}

function extractEnvelope(body: unknown): WireErrorEnvelope | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const error = (body as Record<string, unknown>).error;
  if (error === null || typeof error !== 'object') return undefined;
  const e = error as Record<string, unknown>;
  return {
    type: typeof e.type === 'string' ? e.type : undefined,
    code: typeof e.code === 'string' ? e.code : undefined,
    message: typeof e.message === 'string' ? e.message : undefined,
    doc_url: typeof e.doc_url === 'string' ? e.doc_url : undefined,
    request_id: typeof e.request_id === 'string' ? e.request_id : undefined,
    retry_after_ms: typeof e.retry_after_ms === 'number' ? e.retry_after_ms : undefined,
    details: e.details !== null && typeof e.details === 'object' ? (e.details as Record<string, unknown>) : undefined,
  };
}

function defaultTypeForStatus(status: number): string {
  if (status === 401) return 'authentication';
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 422) return 'unprocessable';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_error';
  return 'invalid_request';
}

export function transportError(message: string, hint?: string): CliError {
  return new CliError({ type: 'upstream_error', code: 'transport', message, hint, source: 'transport', retryable: true });
}
