/**
 * The one error shape every command path funnels into. `output/exitCodes.ts` maps it to the
 * cli.md §4.1 exit contract; `output/emit.ts` renders it as the §3 error envelope.
 */

export type ErrorSource = 'local' | 'api' | 'transport';

export interface CliErrorFields {
  /** Server ErrorType member for api errors; a local kind ('usage', 'auth', ...) otherwise. */
  type: string;
  /** Narrow machine code (server `code`, or a local code such as 'bad_flag'). */
  code: string;
  message: string;
  source: ErrorSource;
  hint?: string;
  docUrl?: string;
  requestId?: string;
  retryable?: boolean;
  retryAfterS?: number;
  /** Code-specific details passed through from the server envelope (already redacted at emit). */
  details?: Record<string, unknown>;
  /** HTTP status when the error came off the wire. */
  status?: number;
}

export class CliError extends Error {
  readonly fields: CliErrorFields;

  constructor(fields: CliErrorFields) {
    super(fields.message);
    this.name = 'CliError';
    this.fields = fields;
  }

  static usage(message: string, hint?: string): CliError {
    return new CliError({ type: 'invalid_request', code: 'usage', message, hint, source: 'local' });
  }

  static auth(message: string, hint?: string): CliError {
    return new CliError({ type: 'authentication', code: 'no_credentials', message, hint, source: 'local' });
  }

  static internal(message: string): CliError {
    return new CliError({ type: 'internal_error', code: 'cli_internal', message, source: 'local' });
  }

  static io(message: string, hint?: string): CliError {
    return new CliError({ type: 'invalid_request', code: 'io_error', message, hint, source: 'local' });
  }
}

/**
 * Re-throw a typed error with an actionable hint for known, contract-settled codes. A hint that
 * is already set wins (api/errors.ts attaches its own for cli_update_required and the terminal
 * codes) and unknown codes re-throw untouched — this never swallows an error.
 */
export function withCodeHint(err: unknown, hints: Record<string, string>): never {
  if (err instanceof CliError && err.fields.hint === undefined) {
    const hint = hints[err.fields.code];
    if (hint !== undefined) throw new CliError({ ...err.fields, hint });
  }
  throw err;
}

/**
 * The #9292 tolerant lane, shared by every verb that ships ahead of its backend deploy: only a
 * BARE route 404 (no server error envelope → code `http_404`) means the ROUTE is missing (a
 * server predating the endpoint) — re-throw it as that truth. An envelope'd `not_found` is a
 * real missing resource and passes through untouched.
 */
export function rethrowRoutePredates(err: unknown, message: string, hint: string): never {
  if (err instanceof CliError && err.fields.code === 'http_404') {
    throw new CliError({ ...err.fields, message, hint });
  }
  throw err;
}
