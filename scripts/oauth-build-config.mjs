// Which app registrations a build carries for "Connect with Off Grid AI" (Google, Microsoft).
//
// They are application identities, not user data: Google's Desktop client and Microsoft's public
// client are meant to ship inside installed apps. They are still kept out of Git (Google's
// credential pair) and read at build time from, in order:
//   1. the environment (CI passes repository secrets),
//   2. the repo's ignored env files (.env, .env.local, .env.production, .env.production.local),
//   3. a per-user file outside any checkout, ~/.offgrid/build.env, which survives worktrees.
// Microsoft's client ID is public and has no secret, so it defaults to the registered app.
// A release build sets OFFGRID_REQUIRE_OAUTH=1 and fails instead of shipping without them.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Off Grid AI Desktop in Microsoft Entra: public client, no secret (docs/research). */
export const OFFGRID_MICROSOFT_CLIENT_ID = '2bbfd68a-f7ce-4327-8cb9-45760b77c27f'

export const USER_BUILD_ENV = join(homedir(), '.offgrid', 'build.env')

/** KEY=value lines; # comments, blank lines and optional quotes. */
export function parseEnvFile(text) {
  const out = {}
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || line.trim().startsWith('#')) continue
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

/**
 * The registrations to build in. `sources` are tried in order and the first value wins.
 * Returns what is missing so the caller can warn or fail.
 */
export function resolveOauthBuildConfig(sources) {
  const pick = (key) => {
    for (const s of sources) {
      const v = typeof s?.[key] === 'string' ? s[key].trim() : ''
      if (v) return v
    }
    return ''
  }
  const desktopClient = pick('GOOGLE_OAUTH_CLIENT_TYPE') === 'desktop'
  const google = {
    clientId: desktopClient ? pick('GOOGLE_CLIENT_ID') : '',
    clientSecret: desktopClient ? pick('GOOGLE_CLIENT_SECRET') : ''
  }
  const microsoftClientId = pick('MICROSOFT_CLIENT_ID') || OFFGRID_MICROSOFT_CLIENT_ID
  const missing = []
  if (!desktopClient) missing.push('GOOGLE_OAUTH_CLIENT_TYPE=desktop')
  if (!google.clientId) missing.push('GOOGLE_CLIENT_ID')
  if (!google.clientSecret) missing.push('GOOGLE_CLIENT_SECRET')
  return { google, microsoftClientId, missing }
}

/** Read the per-user file when it exists; nothing otherwise. */
export function readUserBuildEnv(file = USER_BUILD_ENV) {
  return existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {}
}

/** Warn on a local build, fail a release build, when Google sign-in would be missing. */
export function checkOauthBuildConfig(config, { pro, require }) {
  if (!pro || config.missing.length === 0) return
  const message =
    `Connect with Off Grid AI for Google is off in this build: missing ${config.missing.join(', ')}. ` +
    `Set them in the environment, in an ignored .env.local, or in ${USER_BUILD_ENV}.`
  if (require) throw new Error(message)
  console.warn(`\n[oauth] ${message}\n`)
}
