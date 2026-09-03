import { app, shell, BrowserWindow, protocol, session, desktopCapturer, screen } from 'electron'
import { join } from 'path'
import { tmpdir } from 'os'
import fs from 'fs'

// Custom scheme to serve local capture screenshots to the renderer (file:// is
// blocked there). Registered before app 'ready'; handled after.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ogcapture',
    privileges: { secure: true, supportFetchAPI: true, bypassCSP: true, stream: true }
  },
  {
    scheme: 'ogartifact',
    privileges: { standard: true, secure: true, stream: true }
  }
])
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { setupIPC } from './ipc' // IMPORT FROM IPC ONLY
import { setupRagIPC } from './rag-ipc'
import { setupMcpIpc } from './mcp-ipc'
import { registerToolExtension } from './tools'
import { registerNativeActionTools } from './tools/nativeActionToolExtension'
import { setupDesktopBackupIPC } from './backup/ipc'
import { preloadPath } from './preload-path'
import { rendererHtmlPath } from './renderer-path'
import { setMainWindow } from './main-window'
import { startModelServer, stopModelServer } from './model-server'
import { startMediaServer, stopMediaServer, mediaUrlFor } from './media-server'
import { capturePathFromUrl, serveCaptureFile } from './ogcapture-serve'
import { serveArtifactPreview } from './artifact-preview'
import { ipcMain } from 'electron'
import { installWindowZoom, installZoomMenu, WINDOW_ZOOM_LEVEL_SETTING } from './window-zoom'
import { loadProEntitlementProvider, loadProFeaturesMain } from './bootstrap/loadProFeaturesMain'
import { resolveWindowPresentation } from './bootstrap/window-presentation'
import { mayUseIsolatedEvidenceInstance } from './bootstrap/isolated-evidence-instance'

/**
 * Whether this launch may put itself on screen or take the keyboard. Resolved ONCE: the main window, the Dock
 * tile, the second-instance focus and every window pro opens must all give the same answer, or a headless run
 * is only partly headless - which is exactly the bug this fixes.
 */
const windowPresentation = resolveWindowPresentation(process.env)
import {
  initLicensing,
  refreshCachedProEntitlement,
  revalidateProEntitlement
} from './licensing/license-service'
import { PERSONAL_MESH_ENTITLEMENT_REVALIDATION_INTERVAL_MS } from '@offgrid/sync'
import { setupLicenseIpc } from './license-ipc'
import { nativeImage } from 'electron'
import { getSetting, purgeLegacyChatImports, saveSetting } from './database'
import { guardConsoleStreams } from './stream-guards'
import { PRODUCT_NAME } from '../shared/product-identity'
import { installMediaPermissionHandler } from './media-permission'
import { localMediaRoots } from './media-roots'
import { resourceDirs } from './runtime-env'
import { beginProductIdentityBootstrap } from './product-identity-lifecycle'
import { repairMissingDefaultKeychainAtBootstrap } from './secure-storage-bootstrap'
import {
  installDiagnosticConsoleCapture,
  installIpcDiagnostics,
  writeDiagnosticLog
} from './diagnostics-log'
import {
  applicationShutdown,
  commitApplicationRelaunch,
  installApplicationShutdown,
  registerCoreShutdownOwners
} from './shutdown'
import { shutdownModelDownloads } from './models-manager'

// Before anything logs: a broken stdout/stderr pipe (parent/e2e-harness exited, closed pipe)
// must never crash main via an uncaught EPIPE. See stream-guards.ts.
guardConsoleStreams([process.stdout, process.stderr])

// Electron asks macOS for its safeStorage password during early bootstrap. Repair
// the one safe, known-bad state before that lookup can trigger SecurityAgent's
// generic "Keychain Not Found" dialog. This never creates or resets a Keychain.
const secureStorageBootstrap = repairMissingDefaultKeychainAtBootstrap(
  process.platform,
  app.isPackaged
)
if (secureStorageBootstrap?.status === 'repaired') {
  console.warn(`[secure-storage] ${secureStorageBootstrap.detail}`)
} else if (secureStorageBootstrap && secureStorageBootstrap.status !== 'healthy') {
  console.error(`[secure-storage] ${secureStorageBootstrap.detail}`)
}

// Pin one canonical userData dir ("Off Grid AI Desktop") regardless of package
// name, and migrate data from the legacy split dirs ("My Memories" had the
// models, "my-memories" had the DB) so nothing is lost / re-downloaded. Must run
// before app 'ready' and before any getPath('userData') usage.
// Preserve the Keychain namespace used by every existing install during Electron's
// early safeStorage bootstrap. The returned callback restores the canonical visible
// product name at the beginning of the ready phase.
const restoreCanonicalProductName = beginProductIdentityBootstrap(app, process.platform)
;(function unifyUserDataPath(): void {
  try {
    // Test/CI seam: let a harness isolate userData (e.g. screenshot capture of
    // a fresh, pre-onboarding profile). Harmless in production (unset).
    if (process.env.OFFGRID_USER_DATA) {
      fs.mkdirSync(process.env.OFFGRID_USER_DATA, { recursive: true })
      app.setPath('userData', process.env.OFFGRID_USER_DATA)
      console.log('[userData] override path:', process.env.OFFGRID_USER_DATA)
      return
    }
    const appData = app.getPath('appData')
    const canonical = join(appData, 'Off Grid AI Desktop')
    fs.mkdirSync(canonical, { recursive: true })
    const move = (fromDir: string, name: string): void => {
      try {
        const src = join(fromDir, name)
        const dst = join(canonical, name)
        if (fs.existsSync(src) && !fs.existsSync(dst)) fs.renameSync(src, dst)
      } catch (e) {
        console.warn('[userData] migrate skip', name, e)
      }
    }
    move(join(appData, 'My Memories'), 'models')
    move(join(appData, 'my-memories'), 'models')
    move(join(appData, 'my-memories'), 'memories.db')
    move(join(appData, 'My Memories'), 'memories.db')
    app.setPath('userData', canonical)
  } catch (e) {
    console.error('[userData] unify failed', e)
  }
})()

installDiagnosticConsoleCapture()
writeDiagnosticLog('app', 'bootstrap.started', {
  version: app.getVersion(),
  packaged: app.isPackaged,
  platform: process.platform,
  arch: process.arch
})

installApplicationShutdown(app, applicationShutdown, ({ owner, error }) =>
  console.error(`[shutdown] ${owner} failed`, error)
)
registerCoreShutdownOwners(applicationShutdown, {
  stopGateway: stopModelServer,
  stopMediaServer,
  stopModelDownloads: shutdownModelDownloads
})

function createWindow(): void {
  // Open filling the screen, because this is a desktop-first, dense app: multi-column grids, master
  // detail lists and side panels. At 900x670 the Models grid collapsed to one card per row, the chat
  // history rail ate a third of the width, and every screen looked like a phone layout stretched.
  //
  // The work area, not the display bounds - that excludes the menu bar and Dock, so the window fills
  // what the user can actually use. maximize() on top of it because the work area is only the
  // starting size; maximizing is what makes the OS treat the window as filled and keeps it that way
  // through a display change.
  //
  // Not fullscreen: on macOS that moves the app to its own Space and hides the menu bar, so a user who
  // just wanted a big window loses Mission Control and every other window alongside it.
  const { workAreaSize } = screen.getPrimaryDisplay()
  const mainWindow = new BrowserWindow({
    width: workAreaSize.width,
    height: workAreaSize.height,
    // The old default is now the floor: below this the dense layouts stop working.
    minWidth: 900,
    minHeight: 670,
    show: false,
    title: PRODUCT_NAME,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' || process.platform === 'win32' ? { icon } : {}),
    webPreferences: {
      preload: preloadPath(),
      sandbox: false, // REQUIRED for IPC
      contextIsolation: true,
      plugins: true, // Chromium's built-in PDF viewer (chat attachment viewer) needs this
      devTools: is.dev // no inspector in the packaged/production build (tamper-proofing)
    }
  })
  // Cmd/Ctrl + and - zoom the page; the app has no menu bar to carry the standard roles. The
  // level persists with the other settings.
  const zoomStore = {
    read: () => getSetting<number>(WINDOW_ZOOM_LEVEL_SETTING, 0),
    write: (level: number) => saveSetting(WINDOW_ZOOM_LEVEL_SETTING, level)
  }
  installWindowZoom(mainWindow, zoomStore)
  installZoomMenu(() => BrowserWindow.getFocusedWindow() ?? mainWindow, zoomStore)

  // Record THE main window so callers that lay a view over it (the browser
  // rail) attach to the right window, not a stray overlay from getAllWindows().
  setMainWindow(mainWindow)

  // Maximized before the first paint, not on ready-to-show: the window is still hidden here, so it
  // opens at full size instead of appearing at the constructed size and jumping. It also means anything
  // that reads the window as soon as it exists sees the real geometry - on ready-to-show the renderer
  // can already have loaded, so the size depended on which happened first.
  mainWindow.maximize()

  // Nothing is shown in a headless (e2e) run - see window-presentation for why the suite needs that on
  // macOS, where Playwright cannot make an Electron app headless and there is no xvfb to hide it behind.
  // The renderer has already loaded and painted by now either way, which is all Playwright drives.
  mainWindow.on('ready-to-show', () => {
    if (windowPresentation.showWindow) mainWindow.show()
  })

  // Pinch-zoom stays off; the keyboard zoom above owns the level and restores it on load.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.setVisualZoomLevelLimits(1, 1)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(rendererHtmlPath())
  }
}

// The menu-bar (Tray) control surface for always-on capture (pause/resume +
// recalibrate) is a pro feature — pro's activateMain builds it. The free build
// has no tray.

// Only one instance may run: a second instance would share os.tmpdir() and the
// meetings DB, so its orphan-recovery could adopt/kill the first instance's LIVE
// recorder. Bail before whenReady if we can't get the lock; focus the existing
// window instead.
const isolatedEvidenceInstance = mayUseIsolatedEvidenceInstance(process.env, tmpdir())
if (!isolatedEvidenceInstance && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      if (windowPresentation.showWindow) win.focus()
    }
  })
}

// Windows this file does not own must obey the same answer. pro opens several that call show()+focus()
// themselves - the clipboard quick-open popup, the tray and CRM notification surfaces, the meeting notice -
// so hiding only the main window left a headless run still stealing the keyboard, once per spec that touches
// them. Making every window non-focusable is the technique pro's dictation overlay already uses deliberately
// (pro/main/dictation/overlay.ts: non-focusable + showInactive, so the user's target app keeps the keys);
// here it is applied to all of them, from the one place that knows the launch is headless.
//
// Visibility is deliberately left alone. Popups stay visible and their isVisible()-gated logic keeps working,
// which is what lets the clipboard quick-open journey pass headless - it just cannot take focus any more.
if (!windowPresentation.showWindow) {
  app.on('browser-window-created', (_event, win) => {
    win.setFocusable(false)
  })
}

app.whenReady().then(async () => {
  restoreCanonicalProductName()

  // Server-only (headless) mode: boot just the multimodal gateway + LLM runtime,
  // no window / tray / capture / CRM loops. Lets the gateway be deployed on its
  // own — `<app-binary> --server-only` (or OFFGRID_SERVER_ONLY=1) — while still
  // reusing the Electron-built native binaries. First step toward a standalone
  // gateway CLI (see docs/GATEWAY_SPINE.md "externalize later").
  const serverOnly =
    process.argv.includes('--server-only') || process.env.OFFGRID_SERVER_ONLY === '1'
  if (serverOnly) {
    console.log('[gateway] server-only mode — gateway on :7878, no UI/capture')
    if (process.platform === 'darwin' && app.dock) {
      try {
        app.dock.hide()
      } catch {
        /* ignore */
      }
    }
    // startModelServer is async (it scans for a free port); a try/catch can't catch its rejection,
    // so handle it on the promise itself.
    startModelServer().catch((e) => console.error('[gateway] start failed', e))
    void import('./composition/application')
      .then(async ({ desktopApplication, startDesktopApplication }) => {
        await startDesktopApplication()
        const outcome = await desktopApplication.models.prepare('text')
        if (!outcome.ok) throw new Error(outcome.failure.kind)
      })
      .catch((err) => console.error('[gateway] LLM init failed', err))
    return // skip window, tray, IPC, capture, connectors — gateway only
  }

  console.log('APP READY: Initializing Services...')

  // One-time, idempotent cleanup of the old "My Memories" AI-chat imports.
  try {
    purgeLegacyChatImports()
  } catch (e) {
    console.warn('[startup] legacy purge failed', e)
  }

  // Dock icon = the Off Grid AI green chip logo (in dev macOS otherwise shows the
  // default Electron icon; the packaged build uses build/icon from electron-builder).
  if (process.platform === 'darwin' && app.dock) {
    try {
      // Out of the Dock entirely in a headless run: an app with a Dock tile still becomes the frontmost
      // application, which is the half of the interruption that is not the window itself.
      if (!windowPresentation.showInDock) {
        app.dock.hide()
      } else {
        const dockImg = nativeImage.createFromPath(icon)
        if (!dockImg.isEmpty()) app.dock.setIcon(dockImg)
      }
    } catch (e) {
      console.warn('[dock] setIcon failed', e)
    }
  }

  // Serve local capture screenshots + entity photos + meeting videos to the
  // renderer (file:// is blocked there). We answer HTTP Range ourselves so <video>
  // can seek large recordings: a Range request gets 206 + Content-Range; a plain
  // request gets 200 + Accept-Ranges so the player learns it can seek.
  //
  // The subtle part: on every seek the player CANCELS the in-flight body. We must
  // tear the file stream down SILENTLY — never call controller.error/close after a
  // cancel — otherwise Chromium treats the seek as a failed load and resets to 0:00.
  // (net.fetch(file://) sidesteps this but doesn't honour Range, so seeking is dead.)
  // Only serve files inside the app's own media dirs — this scheme is reachable
  // from the renderer, so serving an arbitrary decoded path would be a local-file
  // read primitive. isPathAllowed is symlink-safe (canonicalizes both sides).
  // NOTE: keep this in sync with the dirs the renderer requests over ogcapture://.
  // 'generated-images' + 'style-thumbs' were missing, so every image-gen output and
  // every style-picker thumbnail 403'd and rendered as a broken image.
  const ogCaptureRoots = localMediaRoots(app.getPath('userData'), resourceDirs())
  protocol.handle('ogcapture', async (request) => {
    try {
      // Parsed, not sliced: a Windows drive letter lands in the URL's host and loses its colon, so
      // slicing produced `C/Users/…` and every preview 404'd on that platform alone.
      const requestedPath = capturePathFromUrl(request.url)
      return serveCaptureFile(requestedPath, ogCaptureRoots, request.headers.get('Range'))
    } catch {
      return new Response(null, { status: 400 })
    }
  })

  // Model-generated executable documents use a separate opaque origin and their
  // own response CSP. The trusted renderer never receives their inline/eval grants.
  protocol.handle('ogartifact', (request) => serveArtifactPreview(request.url))

  // Meeting recorder: grant SYSTEM AUDIO (loopback) for getDisplayMedia so the
  // recorder can capture remote participants on macOS 13+ via ScreenCaptureKit.
  // Audio stays on device; this only fires when the renderer explicitly records.
  try {
    session.defaultSession.setDisplayMediaRequestHandler(
      async (_request, callback) => {
        try {
          const sources = await desktopCapturer.getSources({ types: ['screen'] })
          // Multi-monitor: record the display the user is actually on (cursor),
          // not an arbitrary sources[0].
          let pick = sources[0]
          try {
            const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
            const m = sources.find((s) => s.display_id === String(disp.id))
            if (m) pick = m
          } catch {
            /* single display */
          }
          callback({ video: pick, audio: 'loopback' })
        } catch {
          callback({})
        }
      },
      { useSystemPicker: false }
    )
  } catch (e) {
    console.warn('[meetings] display-media handler setup failed', e)
  }

  // Grant microphone access for in-app voice input (STT). The OS still gates the
  // actual mic behind its own prompt (NSMicrophoneUsageDescription); this just
  // lets the renderer's getUserMedia request through Electron's permission layer.
  try {
    installMediaPermissionHandler(session.defaultSession)
  } catch (e) {
    console.warn('[voice] permission handler setup failed', e)
  }

  // NOTE: Accessibility is a Pro permission for global input/text insertion — the
  // free build never asks for it. Screen capture itself is owned by pro/focus.ts.

  // Set app user model id for Windows notifications/taskbar grouping.
  electronApp.setAppUserModelId('co.getoffgridai.desktop')

  // Native About panel branding (macOS / Linux).
  try {
    app.setAboutPanelOptions({
      applicationName: PRODUCT_NAME,
      applicationVersion: app.getVersion(),
      copyright: 'Off Grid AI — private, on-device AI',
      website: 'https://getoffgridai.co'
    })
  } catch {
    /* not supported on this platform */
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 2. Setup IPC Handlers (core) + the local model gateway
  try {
    installIpcDiagnostics(ipcMain)
    // Licensing first: load the cached Keygen entitlement into memory and register
    // the SYNC `pro:is-enabled` handler BEFORE createWindow() (line below) so the
    // preload's sendSync resolves and window.api.isPro reflects the real license.
    await loadProEntitlementProvider()
    initLicensing()
    await revalidateProEntitlement('launch')
    setupLicenseIpc()
    const entitlementRefresh = setInterval(() => {
      refreshCachedProEntitlement()
      void revalidateProEntitlement('foreground')
    }, PERSONAL_MESH_ENTITLEMENT_REVALIDATION_INTERVAL_MS)
    entitlementRefresh.unref()
    applicationShutdown.register({
      name: 'pro:entitlement-refresh',
      shutdown: () => clearInterval(entitlementRefresh)
    })
    setupIPC()
    await import('./composition/application').then(({ startDesktopApplication }) =>
      startDesktopApplication()
    )
    setupRagIPC()
    setupMcpIpc() // basic MCP connectors (management + chat tool extension)
    registerNativeActionTools(registerToolExtension) // the assistant's tools (macOS full set; Windows Outlook subset)
    const { registerActionsIpc } = await import('./actions/actions-ipc')
    registerActionsIpc() // Approval UX v2: inline gate cards + outcome/undo feed
    const { registerBrowserViewIpc } = await import('./browser/browser-host')
    registerBrowserViewIpc() // dock the live browser view to the pane's region
    const { registerVisionIpc } = await import('./vision/vision-controller')
    registerVisionIpc() // the vision rail's supervisor Stop/Pause/Resume
    const { registerSupervisorWindowIpc } = await import('./vision/supervisor-window')
    registerSupervisorWindowIpc()
    const { registerTaskHistoryIpc } = await import('./tasks/task-history-ipc')
    registerTaskHistoryIpc() // one durable Web Use + Computer Use history
    setupDesktopBackupIPC()
    // Repair legacy catalog classifications before any runtime reads the active chat model.
    // A specialist such as Holo must never start as the normal text model after an upgrade.
    const modelManager = await import('./models-manager')
    await modelManager.reconcileActiveModelClassification().catch(() => false)
    await modelManager.reconcileActiveModelProjector().catch(() => false)
    // one OpenAI-compatible local gateway (LLM + STT); auto-picks a free port. Async, so handle a
    // rejection on the promise (a try/catch around a fire-and-forget async call can't catch it).
    startModelServer().catch((e) => console.error('[model-server] start failed', e))
    startMediaServer() // loopback HTTP for seekable local media (meeting videos)
    ipcMain.handle('media:url', (_e, absPath: string) => mediaUrlFor(absPath))
    // (clipboard is now a pro feature — setupClipboard runs in pro's activateMain)
    // Pro features (capture, CRM, meetings, connectors, secretary, proactive,
    // skills engine, console, tray) register their own IPC + intervals/capture loop
    // here. No-op in the free build (the pro submodule is absent → stub).
    void loadProFeaturesMain().catch((e) => console.error('[pro] load failed', e))
    // Demo seeder for testing: OFFGRID_SEED=1 seeds once; OFFGRID_SEED=force re-seeds.
    if (process.env.OFFGRID_SEED) {
      void import('./dev-seed')
        .then((m) => m.seedDemo(process.env.OFFGRID_SEED === 'force'))
        .catch((e) => console.error('[seed]', e))
    }
  } catch (e) {
    console.error('FATAL: IPC Setup failed', e)
  }

  // 3. Initialize LLM (Async)
  // We don't await this to avoid blocking window creation
  import('./composition/application-access').then(({ desktopModels, modelsFailureMessage }) => {
    desktopModels
      .prepare('text')
      .then((outcome) => {
        if (!outcome.ok) throw new Error(modelsFailureMessage(outcome.failure))
      })
      .catch((err) => console.error('Failed to init LLM:', err))
  })

  createWindow()

  // Update IPC is always registered (the renderer queries staged-version on startup
  // in every build); the auto-download engine runs production-only (dev has no feed).
  import('./updater')
    .then((m) => {
      m.registerUpdateIpc()
      if (!is.dev) m.startAutoUpdates()
    })
    .catch((e) => console.error('[update] init', e))

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on('browser-window-focus', () => {
    refreshCachedProEntitlement()
    void revalidateProEntitlement('foreground')
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Cleanly tear down the chat engine on quit so llama-server doesn't linger holding the model port
// (which blocked launching LM Studio without a reboot). Defer the actual quit until the engine is
// terminated (SIGTERM → SIGKILL if it hangs on a Metal/GGML shutdown abort), then quit for real.
let engineUnloaded = false
let shutdownTask: Promise<void> | null = null
app.on('before-quit', (event) => {
  if (engineUnloaded) {
    return
  }
  event.preventDefault()
  if (shutdownTask) return
  shutdownTask = (async () => {
    // Stop the agent browser first so a playing video's audio dies immediately,
    // not whenever the process finally exits.
    try {
      const { disposeBrowserHost } = await import('./browser/browser-host')
      disposeBrowserHost()
    } catch {
      /* best-effort — never block quit */
    }
    try {
      const { stopDesktopApplication } = await import('./composition/application')
      await stopDesktopApplication()
    } catch (error) {
      console.error('[shutdown] application stop failed', error)
      throw error
    } finally {
      engineUnloaded = true
      commitApplicationRelaunch(app)
      app.quit()
    }
  })()
  void shutdownTask
})
