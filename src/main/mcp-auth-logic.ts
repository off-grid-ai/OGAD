// The pure half of the MCP action-tool auth gate. The desktop's ACTION tools
// (mail_send, web_use, computer_use, ...) DO things, so - unlike the open
// model/inference tools - they are only exposed to a request that presents the
// desktop's action token (issued to a paired device). Model tools stay open.
//
// This is the constant-time bearer check, kept electron-free so it is unit
// tested; the token store + request glue live in mcp-auth.ts.
import { timingSafeEqual } from 'crypto'

/** True iff `headerValue` is `Bearer <token>` matching `token` exactly. Uses a
 *  constant-time compare so a wrong token can't be guessed by timing. A blank
 *  configured token never authorizes (fail closed). */
export function authorizeBearer(headerValue: string | undefined, token: string): boolean {
  if (!token || token.length < 16) {
    return false
  }
  if (!headerValue) {
    return false
  }
  const trimmed = headerValue.trim()
  let separator = 0
  while (separator < trimmed.length && trimmed.charCodeAt(separator) > 32) separator += 1
  if (separator === trimmed.length || trimmed.slice(0, separator).toLowerCase() !== 'bearer') {
    return false
  }
  while (separator < trimmed.length && trimmed.charCodeAt(separator) <= 32) separator += 1
  const credential = trimmed.slice(separator)
  if (!credential || credential.trim() !== credential || credential.includes(' ')) {
    return false
  }
  const provided = Buffer.from(credential, 'utf8')
  const expected = Buffer.from(token, 'utf8')
  if (provided.length !== expected.length) {
    return false
  }
  return timingSafeEqual(provided, expected)
}

/** True iff `headerValue` is a valid `Bearer` for ANY token in `tokens`. This is how the
 *  per-device model works: each paired+tools-allowed device has its own token, and a request
 *  authorizes only if its bearer matches one that is LIVE right now. An empty list (no paired
 *  device may run tools) never authorizes - fail closed. Checks every token (no early return on
 *  a match) so the time taken does not reveal which device matched. */
export function authorizeBearerAny(headerValue: string | undefined, tokens: readonly string[]): boolean {
  let authorized = false
  for (const token of tokens) {
    if (authorizeBearer(headerValue, token)) {
      authorized = true
    }
  }
  return authorized
}
