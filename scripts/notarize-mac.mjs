// electron-builder afterSign hook: notarize the signed app, then staple its ticket.
//
// electron-builder's built-in `notarize: true` staples with only three quick retries (about seven
// seconds). Apple's ticket service (api.apple-cloudkit.com) drops connections from CI runners for
// longer than that ("The network connection was lost", stapler error 68), which failed every Mac
// release job on 2026-10-12. This hook runs the same @electron/notarize submission and gives the
// staple a window of minutes. A rejected submission or a missing ticket still fails at once.
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import electronNotarize from '@electron/notarize'

const execFileAsync = promisify(execFile)
const STAPLE_ATTEMPTS = 10
const STAPLE_RETRY_MS = 30_000
const NETWORK_FAILURE = /NSURLErrorDomain|network connection was lost|Error 68/

const systemBoundary = Object.freeze({
  notarize: (options) => electronNotarize.notarize(options),
  staple: (appPath) => execFileAsync('/usr/bin/xcrun', ['stapler', 'staple', '-v', appPath]),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
})

function failureText(error) {
  if (!(error instanceof Error)) return String(error)
  return [error.message, error.stdout, error.stderr].filter(Boolean).join('\n')
}

/** The notarytool credentials electron-builder reads, from the same environment variables. */
export function notarizeCredentials(environment) {
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = environment
  if (!APPLE_API_KEY && !APPLE_API_KEY_ID && !APPLE_API_ISSUER) return undefined
  if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) {
    throw new Error('APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER must all be set')
  }
  return {
    appleApiKey: APPLE_API_KEY,
    appleApiKeyId: APPLE_API_KEY_ID,
    appleApiIssuer: APPLE_API_ISSUER
  }
}

/** Staple, retrying only while Apple's ticket service drops the connection. */
export async function stapleWithRetry(appPath, boundary = systemBoundary) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await boundary.staple(appPath)
    } catch (error) {
      const text = failureText(error)
      if (attempt >= STAPLE_ATTEMPTS || !NETWORK_FAILURE.test(text)) throw error
      console.log(`[notarize] staple attempt ${attempt} lost Apple's ticket service; retrying`)
      await boundary.wait(STAPLE_RETRY_MS)
    }
  }
}

/** Notarize, then make sure the ticket is stapled even if @electron/notarize's own staple gave up. */
export async function notarizeAndStaple(appPath, credentials, boundary = systemBoundary) {
  try {
    await boundary.notarize({ tool: 'notarytool', appPath, ...credentials })
  } catch (error) {
    // Submission and acceptance already succeeded when only the staple failed. Recover only when
    // that failure was Apple's ticket service dropping the connection; a missing ticket propagates.
    const text = failureText(error)
    if (!/Failed to staple/.test(text) || !NETWORK_FAILURE.test(text)) throw error
    console.log('[notarize] notarization accepted; stapling with a longer retry window')
    await stapleWithRetry(appPath, boundary)
  }
}

export default async function notarizeMac(context) {
  if (context.electronPlatformName !== 'darwin') return
  const credentials = notarizeCredentials(process.env)
  if (!credentials) {
    console.log('[notarize] skipped: no Apple notarization credentials in the environment')
    return
  }
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  await notarizeAndStaple(appPath, credentials)
  console.log('[notarize] notarized and stapled', appPath)
}
