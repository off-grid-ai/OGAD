// The pure half of the MCP action-tool auth gate. The desktop's ACTION tools
// (mail_send, web_task, computer_task, ...) DO things, so - unlike the open
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
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim())
  if (!match || !match[1]) {
    return false
  }
  const provided = Buffer.from(match[1], 'utf8')
  const expected = Buffer.from(token, 'utf8')
  if (provided.length !== expected.length) {
    return false
  }
  return timingSafeEqual(provided, expected)
}
