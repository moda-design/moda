/**
 * The fetch wrapper: headers, timeouts, retry (cli.md §4.2), idempotency keys, version-header
 * capture. No HTTP library — Bun's native fetch + AbortSignal.timeout.
 */
import { CliError } from '../cliError.ts';
import { recordVersionHeaders } from '../update.ts';
import { CLI_VERSION, userAgent } from '../version.ts';
import { API_VERSION_PIN, HEADER_CLI_VERSION } from './endpoints.ts';
import { apiErrorFromResponse, transportError } from './errors.ts';
import { deriveIdempotencyKey, type IdempotencyParts } from './idempotency.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  method: HttpMethod;
  /** Path from api/endpoints.ts only. */
  path: string;
  body?: unknown;
  /** Multipart body; mutually exclusive with `body`. */
  formData?: FormData;
  query?: Record<string, string | undefined>;
  /** Mutations only (§2.5). */
  idempotency?: IdempotencyParts;
  timeoutMs?: number;
  /** Return raw bytes instead of parsed JSON (downloads). */
  raw?: boolean;
  /** Non-idempotent create with no server-side key: never auto-retry on transport/5xx. */
  noRetryTransport?: boolean;
}

export interface ApiResponse<T> {
  status: number;
  body: T;
  bytes?: Uint8Array;
  headers: Headers;
  requestId?: string;
  durationMs: number;
}

export interface ClientOptions {
  apiBase: string;
  apiKey?: string;
  /** --no-retry */
  noRetry?: boolean;
  /** --timeout ceiling (seconds → ms applied by the caller). Bounds 429 waiting too. */
  defaultTimeoutMs?: number;
  /** Busy-conflict backoff schedule; tests inject a fast one. */
  busyBackoffMs?: readonly number[];
  transportRetries?: number;
  sleeper?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  /** Stderr notice hook (progress lines never touch stdout). */
  onNotice?: (message: string) => void;
}

const DEFAULT_BUSY_BACKOFF_MS = [5_000, 15_000, 30_000] as const;
const DEFAULT_TIMEOUT_MS = 120_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ApiClient {
  private readonly opts: ClientOptions;

  constructor(opts: ClientOptions) {
    this.opts = opts;
  }

  async request<T = unknown>(op: RequestOptions): Promise<ApiResponse<T>> {
    const sleep = this.opts.sleeper ?? defaultSleep;
    const busySchedule = this.opts.noRetry ? [] : (this.opts.busyBackoffMs ?? DEFAULT_BUSY_BACKOFF_MS);
    const transportBudget = this.opts.noRetry || op.noRetryTransport === true ? 0 : (this.opts.transportRetries ?? 2);
    const timeoutMs = op.timeoutMs ?? this.opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    let busyAttempt = 0;
    let transportAttempt = 0;
    let rateLimitWaitedMs = 0;

    for (;;) {
      let response: Response;
      const started = performance.now();
      try {
        response = await fetch(this.buildUrl(op), this.buildInit(op, timeoutMs));
      } catch (err) {
        if (transportAttempt < transportBudget) {
          transportAttempt += 1;
          await sleep(250 * 2 ** transportAttempt + Math.random() * 250);
          continue;
        }
        const detail = err instanceof Error ? err.message : String(err);
        throw transportError(`Request to ${this.opts.apiBase} failed: ${detail}`, 'Check connectivity and --api-base.');
      }
      const durationMs = Math.round(performance.now() - started);
      recordVersionHeaders(response.headers, this.opts.env ?? process.env);
      const requestId = response.headers.get('X-Request-ID') ?? undefined;

      if (response.ok) {
        if (op.raw === true) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          return { status: response.status, body: undefined as T, bytes, headers: response.headers, requestId, durationMs };
        }
        const body = (await this.parseJson(response)) as T;
        return { status: response.status, body, headers: response.headers, requestId, durationMs };
      }

      const errBody = await this.parseJson(response).catch(() => undefined);
      const headerRetryMs = this.retryAfterMs(response.headers, undefined);
      const error = apiErrorFromResponse(
        response.status,
        errBody,
        requestId,
        headerRetryMs !== undefined ? Math.ceil(headerRetryMs / 1000) : undefined,
      );

      // 5xx — transport-class retry (safe: mutations and metered verbs carry idempotency keys).
      // Terminal 5xx codes (retryable: false from the envelope, e.g. web_read_failed) surface
      // immediately: they are content failures that would fail identically on retry.
      if (response.status >= 500 && error.fields.retryable === true && transportAttempt < transportBudget) {
        transportAttempt += 1;
        await sleep(250 * 2 ** transportAttempt + Math.random() * 250);
        continue;
      }

      // 429 — honor Retry-After up to the timeout ceiling, then surface (exit 6).
      if (response.status === 429 && !this.opts.noRetry) {
        const waitMs = this.retryAfterMs(response.headers, error.fields.retryAfterS) ?? 1_000;
        if (rateLimitWaitedMs + waitMs <= timeoutMs) {
          rateLimitWaitedMs += waitMs;
          this.opts.onNotice?.(`rate limited — waiting ${Math.ceil(waitMs / 1000)}s`);
          await sleep(waitMs);
          continue;
        }
      }

      // canvas_busy conflict — 3 attempts, 5s/15s/30s, server retry_after_s wins.
      if (error.fields.type === 'conflict' && error.fields.code === 'canvas_busy' && busyAttempt < busySchedule.length) {
        const scheduled = busySchedule[busyAttempt] as number;
        const serverMs = error.fields.retryAfterS !== undefined ? error.fields.retryAfterS * 1000 : undefined;
        const waitMs = serverMs ?? scheduled;
        busyAttempt += 1;
        this.opts.onNotice?.(`canvas busy — retry ${busyAttempt}/${busySchedule.length} in ${Math.ceil(waitMs / 1000)}s`);
        await sleep(waitMs);
        continue;
      }

      throw error;
    }
  }

  private buildUrl(op: RequestOptions): string {
    const url = new URL(op.path, this.opts.apiBase);
    if (op.query) {
      for (const [key, value] of Object.entries(op.query)) {
        if (value !== undefined) url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  private buildInit(op: RequestOptions, timeoutMs: number): RequestInit {
    const headers: Record<string, string> = {
      'User-Agent': userAgent(),
      'Moda-Version': API_VERSION_PIN,
      [HEADER_CLI_VERSION]: CLI_VERSION,
      Accept: op.raw === true ? '*/*' : 'application/json',
    };
    if (this.opts.apiKey !== undefined) headers.Authorization = `Bearer ${this.opts.apiKey}`;
    let body = op.body;
    if (op.idempotency !== undefined) {
      const key = deriveIdempotencyKey(op.idempotency);
      // The server reads `idempotency_key` from the JSON body (Canvas Actions mutation
      // requests and StartTaskRequest); the header is kept as a transport-level hint.
      headers['Idempotency-Key'] = key;
      if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
        body = { ...(body as Record<string, unknown>), idempotency_key: key };
      }
    }
    const init: RequestInit = { method: op.method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (op.formData !== undefined) {
      init.body = op.formData;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return init;
  }

  private retryAfterMs(headers: Headers, retryAfterS: number | undefined): number | undefined {
    const header = headers.get('Retry-After');
    if (header !== null) {
      const seconds = Number.parseFloat(header);
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    }
    if (retryAfterS !== undefined) return retryAfterS * 1000;
    return undefined;
  }

  private async parseJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new CliError({
        type: 'upstream_error',
        code: 'invalid_response',
        message: `Server returned non-JSON response (HTTP ${response.status}).`,
        source: 'transport',
      });
    }
  }
}
