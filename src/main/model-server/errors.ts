// Pure error shaping for the gateway. No I/O. Extracted from model-server.ts so
// the OpenAI-style error body and the HTTP-status -> error-type mapping are
// unit-testable and defined once.

/** OpenAI-shaped error body. */
export function errBody(
  message: string,
  type = 'invalid_request_error'
): { error: { message: string; type: string } } {
  return { error: { message, type } }
}

/**
 * Map an arbitrary thrown value to a status + OpenAI error type + message.
 * A carried `.status` wins; otherwise 500. The type is derived from the status:
 * 501 -> not_installed, 502 -> upstream_error, 400 -> invalid_request_error,
 * everything else -> server_error.
 */
export function errMeta(e: unknown): { status: number; type: string; message: string } {
  const status = (e as { status?: number } | undefined)?.status ?? 500
  const message = e instanceof Error ? e.message : String(e)
  const type =
    status === 501
      ? 'not_installed'
      : status === 502
        ? 'upstream_error'
        : status === 400
          ? 'invalid_request_error'
          : status === 429
            ? 'rate_limit_error'
            : 'server_error'
  return { status, type, message }
}
