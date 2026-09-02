// Auto-update via electron-updater + GitHub Releases. Checks on launch and every
// few hours; downloads in the background and installs on quit. A native
// notification fires when an update is downloaded (checkForUpdatesAndNotify).
//
// Automatic updates are user-controlled (Settings → Software update). When OFF,
// we never auto-download or auto-install-on-quit, and we skip the periodic check
// — but the user can still run a manual "Check for updates" and choose to install.
import { autoUpdater } from 'electron-updater'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { UpdateInfo } from 'builder-util-runtime'
import type { ProgressInfo } from 'electron-updater'
import { valid } from 'semver'
import { getSetting, saveSetting } from './database'
import { resolveChannelConfig, type UpdateChannel } from './update-channel'
import { listPreviousUpdateReleases } from './update-release-history'
import { GITHUB_UPDATE_PROVIDER } from '../shared/update-provider'

// Version of an update that finished downloading and is staged for install
// (null = none). Held in main so a window created AFTER the download finished
// (on macOS the app keeps running with zero windows) can still seed the banner
// via update:staged-version — the update:downloaded event alone only reaches
// windows that existed at download time.
let stagedVersion: string | null = null
let availableVersion: string | null = null
let targetedDownloadVersion: string | null = null
type UpdateDownloadProgress = ProgressInfo & {
  status: 'downloading' | 'completed' | 'failed'
  version: string | null
  error?: string
}
let updateDownloadProgress: UpdateDownloadProgress | null = null

function publishDownloadProgress(progress: UpdateDownloadProgress): void {
  updateDownloadProgress = progress
  BrowserWindow.getAllWindows().forEach((window) =>
    window.webContents.send('update:download-progress', progress)
  )
}

const platformSupportsUpdate = autoUpdater.isUpdateSupported

function autoEnabled(): boolean {
  return getSetting<boolean>('updates:auto', true) // default ON
}

function channelPref(): UpdateChannel {
  return getSetting<UpdateChannel>('updates:channel', 'stable') // default stable
}

function skippedVersion(): string | null {
  const stored = getSetting<string | null>('updates:skipped-version', null)
  return stored && valid(stored) ? stored : null
}

function applySkippedVersionPolicy(): void {
  autoUpdater.isUpdateSupported = async (info: UpdateInfo) => {
    const supported = await Promise.resolve(platformSupportsUpdate(info))
    return supported && info.version !== skippedVersion()
  }
}

// Apply the user's auto-update preference to the updater. With auto OFF nothing
// downloads or installs without an explicit user action.
function applyAutoPref(): void {
  const on = autoEnabled()
  autoUpdater.autoDownload = on
  autoUpdater.autoInstallOnAppQuit = on
}

// Apply the updater's channel knobs from the user's preference. Decision logic is the
// pure, Electron-free resolveChannelConfig. Beta uses the `beta` discovery channel so
// electron-updater selects prereleases, then its GitHub provider falls back from the
// absent beta feed to the one published latest feed. A downgrade is permitted only on
// an explicit channel switch, never on routine launch or interval checks.
function applyChannel(explicitChannelSwitch = false): void {
  const cfg = resolveChannelConfig(channelPref(), explicitChannelSwitch)
  autoUpdater.channel = cfg.channel
  autoUpdater.allowPrerelease = cfg.allowPrerelease
  autoUpdater.allowDowngrade = cfg.allowDowngrade
}

// Register the update IPC surface. Split OUT of startAutoUpdates so it can run in
// EVERY build, including dev: the renderer queries update:staged-version on startup
// regardless of environment, and gating registration behind !is.dev left it with no
// handler ("No handler registered for 'update:staged-version'"). Every handler here is
// safe in dev — reads return the running version / null, and checkForUpdates() itself
// short-circuits on !app.isPackaged. The auto-download ENGINE (feed, listeners,
// background cadence) stays in startAutoUpdates and remains production-only.
export function registerUpdateIpc(): void {
  // Apply a staged update on demand. autoInstallOnAppQuit only swaps the bundle
  // on a GRACEFUL quit — a force-kill (Activity Monitor, kill -9, killall) skips
  // it, so a fully-downloaded update can sit unapplied forever. quitAndInstall
  // forces the clean quit + relaunch + swap, so the renderer's "Restart to
  // update" button always lands the update regardless of how the app is closed.
  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall()
  })

  // Lets a freshly-created window ask whether an update is already staged.
  ipcMain.handle('update:staged-version', () => stagedVersion)
  ipcMain.handle('update:download-progress', () => updateDownloadProgress)

  // Current state for the Settings UI: the running version + auto on/off + channel.
  ipcMain.handle('update:get-prefs', () => ({
    currentVersion: app.getVersion(),
    auto: autoEnabled(),
    channel: channelPref(),
    skippedVersion: skippedVersion()
  }))

  // Toggle automatic updates. Persisted + applied live; turning it on kicks an
  // immediate background check so the user doesn't wait for the next interval.
  ipcMain.handle('update:set-auto', (_e, on: boolean) => {
    saveSetting('updates:auto', !!on)
    applyAutoPref()
    if (on)
      autoUpdater.checkForUpdatesAndNotify().catch((e) => console.error('[update] check failed', e))
    return autoEnabled()
  })

  // Switch update channel (stable ⇄ beta/nightly). Persisted + applied live, then
  // an immediate check so the user sees the channel's latest build right away.
  ipcMain.handle('update:set-channel', (_e, channel: UpdateChannel) => {
    const next: UpdateChannel = channel === 'beta' ? 'beta' : 'stable'
    saveSetting('updates:channel', next)
    // Explicit switch: permit a cross-channel downgrade (e.g. beta → the latest,
    // numerically-lower stable) since the user chose it. Routine checks never do.
    applyChannel(true)
    // Always check after a channel switch so the user gets immediate feedback
    // on what's available — even if auto-updates are off.
    autoUpdater
      .checkForUpdatesAndNotify()
      .catch((e) => console.error('[update] channel check failed', e))
    return next
  })

  ipcMain.handle('update:download', (_e, version: string) => {
    if (targetedDownloadVersion) {
      throw new Error(`Version ${targetedDownloadVersion} is already downloading.`)
    }
    if (!availableVersion || version !== availableVersion) {
      throw new Error('Check for updates again before downloading this version.')
    }
    saveSetting('updates:skipped-version', null)
    // An explicit download must still wait for an explicit restart. On macOS,
    // starting Squirrel with auto-install enabled can stage the bundle for the
    // next quit before the user has another chance to decline.
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    void autoUpdater.downloadUpdate().catch((e) => console.error('[update] download failed', e))
    return { status: 'downloading' as const, version }
  })

  ipcMain.handle('update:skip-version', (_e, version: string) => {
    const normalized = valid(version)
    if (!normalized) throw new Error('Invalid update version.')
    saveSetting('updates:skipped-version', normalized)
    if (availableVersion === normalized) availableVersion = null
    return normalized
  })

  ipcMain.handle('update:clear-skipped-version', () => {
    saveSetting('updates:skipped-version', null)
    return null
  })

  ipcMain.handle('update:list-versions', async () => {
    if (!app.isPackaged) {
      throw new Error('Previous versions are only available in the installed app.')
    }
    const releases = await listPreviousUpdateReleases({
      currentVersion: app.getVersion(),
      platform: process.platform
    })
    return releases.slice(0, 20).map(({ version, channel, publishedAt }) => ({
      version,
      channel,
      publishedAt
    }))
  })

  ipcMain.handle('update:download-version', (_e, version: string) =>
    downloadPreviousVersion(version)
  )

  // Manual "Check for updates". Resolves with a definite status the UI can show.
  // With automatic updates off this only reports availability; download remains
  // a separate, explicit action.
  ipcMain.handle('update:check', () => checkForUpdates())
}

async function downloadPreviousVersion(
  requestedVersion: string
): Promise<{ status: 'downloading'; version: string }> {
  const normalized = valid(requestedVersion)
  if (!normalized) throw new Error('Invalid update version.')
  if (targetedDownloadVersion) {
    throw new Error(`Version ${targetedDownloadVersion} is already downloading.`)
  }

  const releases = await listPreviousUpdateReleases({
    currentVersion: app.getVersion(),
    platform: process.platform
  })
  const target = releases.find((release) => release.version === normalized)
  if (!target) {
    throw new Error('That version is no longer available for this device.')
  }

  targetedDownloadVersion = normalized
  let downloadStarted = false
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.isUpdateSupported = (info) => platformSupportsUpdate(info)

  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: target.feedUrl })
    autoUpdater.channel = 'latest'
    autoUpdater.allowPrerelease = true
    autoUpdater.allowDowngrade = true
    const result = await autoUpdater.checkForUpdates()
    if (!result?.isUpdateAvailable || result.updateInfo.version !== normalized) {
      throw new Error('The selected version could not be verified for download.')
    }

    saveSetting('updates:auto', false)
    const download = autoUpdater.downloadUpdate()
    downloadStarted = true
    void download
      .catch((error) => console.error('[update] previous-version download failed', error))
      .finally(() => {
        targetedDownloadVersion = null
      })
    return { status: 'downloading', version: normalized }
  } finally {
    // downloadUpdate captures the exact provider before returning, so routine
    // checks can safely return to the normal GitHub channel immediately.
    autoUpdater.setFeedURL(GITHUB_UPDATE_PROVIDER)
    applyChannel()
    applySkippedVersionPolicy()
    if (!downloadStarted) {
      targetedDownloadVersion = null
      applyAutoPref()
    }
  }
}

export function startAutoUpdates(): void {
  applySkippedVersionPolicy()
  applyAutoPref()
  applyChannel()

  autoUpdater.on('error', (e) => {
    console.error('[update] error', e)
    if (updateDownloadProgress?.status === 'downloading') {
      publishDownloadProgress({
        ...updateDownloadProgress,
        status: 'failed',
        error: e instanceof Error ? e.message : String(e)
      })
    }
  })
  autoUpdater.on('checking-for-update', () => console.log('[update] checking…'))
  autoUpdater.on('update-available', (i) => {
    availableVersion = i.version
    console.log('[update] available', i.version)
  })
  autoUpdater.on('update-not-available', () => {
    availableVersion = null
    console.log('[update] up to date')
  })
  autoUpdater.on('download-progress', (progress) => {
    publishDownloadProgress({
      ...progress,
      status: 'downloading',
      version: targetedDownloadVersion ?? availableVersion
    })
  })
  autoUpdater.on('update-downloaded', (i) => {
    console.log('[update] downloaded', i.version, '— will install on quit')
    stagedVersion = i.version
    publishDownloadProgress({
      bytesPerSecond: 0,
      percent: 100,
      total: updateDownloadProgress?.total ?? 0,
      transferred: updateDownloadProgress?.total ?? updateDownloadProgress?.transferred ?? 0,
      delta: 0,
      status: 'completed',
      version: i.version
    })
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send('update:downloaded', { version: i.version })
    )
  })

  // Background cadence — only when the user has automatic updates enabled.
  const check = (): void => {
    if (!autoEnabled()) return
    autoUpdater.checkForUpdatesAndNotify().catch((e) => console.error('[update] check failed', e))
  }
  setTimeout(check, 10_000) // shortly after launch
  setInterval(check, 6 * 60 * 60 * 1000) // every 6 hours
}

export type UpdateCheckResult =
  | { status: 'available'; version: string; downloadStarted: boolean }
  | { status: 'not-available'; version: string }
  | { status: 'skipped'; version: string }
  | { status: 'error'; error: string }

/**
 * Run a one-shot update check and resolve with a definite outcome (instead of the
 * fire-and-forget event model), so the Settings button can show a clear result.
 */
export function checkForUpdates(timeoutMs = 30_000): Promise<UpdateCheckResult> {
  // electron-updater only works in a packaged, signed app (it reads app-update.yml,
  // bundled at build time). In a dev/unpackaged run there's nothing to check
  // against, so it would silently hang to the timeout — surface the real reason
  // instead of a vague failure.
  if (!app.isPackaged) {
    return Promise.resolve({
      status: 'error',
      error: 'Updates only work in the installed app, not a dev build.'
    })
  }
  return new Promise<UpdateCheckResult>((resolve) => {
    let done = false
    const finish = (r: UpdateCheckResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      autoUpdater.removeListener('update-available', onAvail)
      autoUpdater.removeListener('update-not-available', onNone)
      autoUpdater.removeListener('error', onErr)
      resolve(r)
    }
    const onAvail = (i: { version: string }): void => {
      availableVersion = i.version
      finish({ status: 'available', version: i.version, downloadStarted: autoUpdater.autoDownload })
    }
    const onNone = (i: { version: string }): void => {
      availableVersion = null
      const skipped = skippedVersion()
      finish(
        skipped && i.version === skipped
          ? { status: 'skipped', version: skipped }
          : { status: 'not-available', version: app.getVersion() }
      )
    }
    const onErr = (e: unknown): void =>
      finish({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    autoUpdater.once('update-available', onAvail)
    autoUpdater.once('update-not-available', onNone)
    autoUpdater.once('error', onErr)
    const timer = setTimeout(
      () => finish({ status: 'error', error: 'Update check timed out' }),
      timeoutMs
    )
    autoUpdater.checkForUpdates().catch((e) => onErr(e))
  })
}
