import { app, dialog, session as electronSession, type Session, type WebContents } from 'electron'
import { getMainWindow } from '../main-window'
import { chromeUserAgent } from './browser-user-agent'

/** The person's own browsing: cookies and sign-ins survive restarts. */
export const PERSONAL_BROWSER_PARTITION = 'persist:agent-browser'

/** Granted without asking: harmless, and every browser allows them. */
const ALWAYS_ALLOWED = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock'])

/** Asked once per site per run. Everything else is refused. */
const ASKED: Record<string, string> = {
  media: 'your camera or microphone',
  geolocation: 'your location',
  notifications: 'to show notifications',
  'clipboard-read': 'to read your clipboard',
  midi: 'your MIDI devices',
  'display-capture': 'to share your screen'
}

export function permissionLabel(permission: string): string | null {
  return ASKED[permission] ?? null
}

export interface PartitionHooks {
  /** A Web Use task page: the agent never gets a device or a prompt. */
  isTaskPage(contents: WebContents): boolean
  /** Hands each partition's downloads to the browser's download list. */
  attachDownloads(session: Session): void
}

const prepared = new Set<string>()
/** `${origin} ${permission}` → the person's answer, for this run. */
const answers = new Map<string, boolean>()

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : null
  } catch {
    return null
  }
}

async function ask(origin: string, permission: string): Promise<boolean> {
  const label = permissionLabel(permission)
  const key = `${origin} ${permission}`
  const known = answers.get(key)
  if (known !== undefined) return known
  if (!label) return false
  const win = getMainWindow()
  const options = {
    type: 'question' as const,
    buttons: ['Allow', 'Block'],
    defaultId: 1,
    cancelId: 1,
    message: `${new URL(origin).host} wants ${label}`,
    detail: 'You can change your mind by reloading the page.'
  }
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  const allowed = response === 0
  answers.set(key, allowed)
  return allowed
}

/**
 * Prepare a browser partition once: user agent, permissions and downloads. `localCaHosts` are a
 * sandbox profile's reserved .test hosts, served by a local-CA proxy: their certificate is
 * trusted in that partition only. Every other host keeps Chromium's own verification.
 */
export function prepareBrowserPartition(
  partition: string,
  hooks: PartitionHooks,
  localCaHosts: readonly string[] = []
): Session {
  const session = electronSession.fromPartition(partition)
  if (prepared.has(partition)) return session
  prepared.add(partition)
  const userAgent = app.userAgentFallback
  if (userAgent) session.setUserAgent(chromeUserAgent(userAgent))
  const local = localCaHosts.filter((host) => host.endsWith('.test'))
  if (local.length) {
    session.setCertificateVerifyProc((request, callback) => {
      const host = request.hostname.toLowerCase()
      callback(local.some((h) => host === h || host.endsWith(`.${h}`)) ? 0 : -3)
    })
  }
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (ALWAYS_ALLOWED.has(permission)) return callback(true)
    const origin = originOf(details.requestingUrl || contents.getURL())
    if (!origin || hooks.isTaskPage(contents)) return callback(false)
    void ask(origin, permission).then(callback, () => callback(false))
  })
  session.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    if (ALWAYS_ALLOWED.has(permission)) return true
    if (contents && hooks.isTaskPage(contents)) return false
    return answers.get(`${originOf(requestingOrigin) ?? ''} ${permission}`) === true
  })
  hooks.attachDownloads(session)
  return session
}
