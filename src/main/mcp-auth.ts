// The desktop's MCP action-tool token: a secret a PAIRED device presents to
// call the action tools (mail_send, web_task, computer_task, ...) over /mcp.
// Model/inference tools stay open. Generated once and persisted in userData.
//
// This is the electron/fs/http glue; the constant-time check is in
// mcp-auth-logic.ts (unit tested).
import fs from 'fs'
import path from 'path'
import type http from 'http'
import { randomBytes } from 'crypto'
import { app } from 'electron'
import { authorizeBearer, authorizeBearerAny } from './mcp-auth-logic'

let cached: string | null = null

/** Supplies the tokens that authorize action tools RIGHT NOW - one per paired device that may
 *  run this Mac's tools. Registered by the pro sync layer, which owns the pairing set; core
 *  stays free of any pairing/device knowledge. Un-pairing a device drops its token from this
 *  list, so its next call is rejected - that is what makes tool access revoke on un-pair. */
export type ActiveActionTokens = () => readonly string[]

let activeActionTokens: ActiveActionTokens | null = null

/** Install (or clear, with null) the live per-device token provider. When set, ONLY those
 *  tokens authorize; the legacy single global token is ignored. */
export function registerActiveActionTokens(provider: ActiveActionTokens | null): void {
  activeActionTokens = provider
}

function tokenPath(): string {
  return path.join(app.getPath('userData'), 'mcp-action-token')
}

/** The action-tool token, generating + persisting one on first use. 32 random
 *  bytes (64 hex chars). Owner-only file perms. */
export function getActionToken(): string {
  if (cached) {
    return cached
  }
  try {
    const existing = fs.readFileSync(tokenPath(), 'utf8').trim()
    if (existing.length >= 32) {
      cached = existing
      return existing
    }
  } catch {
    /* not created yet - generate below */
  }
  const token = randomBytes(32).toString('hex')
  try {
    fs.writeFileSync(tokenPath(), token, { mode: 0o600 })
  } catch {
    /* best effort; still return the in-memory token for this run */
  }
  cached = token
  return token
}

/** True when the request carries a valid action-tool token. Unauthenticated
 *  requests still get the open model tools - just not the action tools.
 *
 *  When the pro sync layer has registered a live-token provider, ONLY the tokens
 *  of currently paired + tools-allowed devices authorize (per-device, revoked on
 *  un-pair). With no provider (free build / no device sync), it falls back to the
 *  legacy single global token, which is never distributed in that build anyway. */
export function isActionAuthorized(req: http.IncomingMessage): boolean {
  const header = req.headers['authorization']
  const provided = Array.isArray(header) ? header[0] : header
  if (activeActionTokens) {
    return authorizeBearerAny(provided, activeActionTokens())
  }
  return authorizeBearer(provided, getActionToken())
}

/** Dev-only: print the action token so a device can be paired for testing. In a
 *  packaged build the token is NEVER logged (that would defeat the gate); the
 *  shipped path surfaces it in a Settings copy-field instead. */
export function logActionTokenForDev(mcpUrl: string): void {
  // `app` is undefined when the gateway is booted outside Electron (integration
  // tests). No app -> no userData -> nothing to log; and never in a real build.
  if (!app || app.isPackaged) {
    return
  }
  console.log(`[mcp] ${mcpUrl} — action tools need: Authorization: Bearer ${getActionToken()}`)
}
