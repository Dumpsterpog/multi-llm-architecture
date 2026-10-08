/**
 * One error type for everything the API returns to clients.
 *
 * Clients (and your own frontend) need errors they can act on
 * programmatically: `type` is a stable machine-readable code, `message` is
 * for humans. e.g. on `rate_limit_exceeded` a client backs off for
 * `retryAfterMs`; on `quota_exceeded` it shows an upgrade prompt.
 */
export type ErrorType =
  | "invalid_request"
  | "authentication_error"
  | "permission_denied"
  | "rate_limit_exceeded"
  | "quota_exceeded"
  | "budget_exceeded"
  | "content_blocked"
  | "context_length_exceeded"
  | "no_models_available"
  | "upstream_error"
  | "internal_error";

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly type: ErrorType,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AppError";
  }

  toJSON() {
    return {
      error: {
        type: this.type,
        message: this.message,
        ...(this.retryAfterMs !== undefined ? { retry_after_ms: this.retryAfterMs } : {}),
      },
    };
  }
}
