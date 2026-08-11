/**
 * Credential/signed-URL scrubbing choke point. Every byte the CLI emits (stdout JSON,
 * human text, stderr messages) passes through here. The model must never see raw
 * `moda_live_*` keys (format: `backend/app/services/api_keys/service.py:29-46`) or
 * signed-URL signature material.
 */

const API_KEY_RE = /moda_(?:live|test)_[0-9a-f]{12,}/g;

/**
 * Query params in URLs that carry signature/credential material. Conservative by design:
 * false positives cost a `[REDACTED]` in output, false negatives leak secrets.
 */
const SIGNED_PARAM_RE =
  /([?&](?:[A-Za-z0-9_-]*(?:[Ss]ignature|[Tt]oken|[Cc]redential|[Ss]ig|[Aa]pi[Kk]ey|[Aa]ccess[Kk]ey))=)[^&"'\s]+/g;

export function redactString(text: string): string {
  return text.replace(API_KEY_RE, 'moda_live_[REDACTED]').replace(SIGNED_PARAM_RE, '$1[REDACTED]');
}

/** Deep-redact a JSON-safe value. Returns a new structure; never mutates the input. */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(v);
    return out as unknown as T;
  }
  return value;
}
