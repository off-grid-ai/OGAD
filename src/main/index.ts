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
import { runIndependentStartupStages, runStartupStage } from './startup-stages'
import { startupProjection } from './startup-projection'
import { registerStartupStatusIpc } from './startup-ipc'
import {
  flushDiagnosticLog,
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
    // Headless: no window exists to open early, so there is nothing to order around. It runs
    // through the SAME stage machinery as the windowed sequence, so its deadlines, its typed
    // results and its degraded reports are the ones every other startup step gets - a second mode
    // is not a second startup contract.
    void runIndependentStartupStages([
      {
        name: 'models.gateway.start',
        deadlineMs: 30_000,
        domain: 'models',
        // A late listener is still owned by the shutdown registry (`stopGateway`), so it cannot
        // outlive the process untracked.
        lateEffectIsRecoverable: true,
        run: () => startModelServer()
      },
      {
        // One start, whatever the deadline does: the composition root memoises the start promise,
        // so a late completion resolves THAT one instead of starting a second runtime.
        name: 'application.start',
        deadlineMs: 20_000,
        required: true,
        lateEffectIsRecoverable: true,
        run: () =>
          import('./composition/application').then(({ startDesktopApplication }) =>
            startDesktopApplication()
          )
      }
    ])
    void runStartupStage({
      name: 'models.text.prepare',
      deadlineMs: 180_000,
      domain: 'models',
      // Cannot be cancelled, but it can be told apart from a later prepare: the stage's operation
      // id is its identity at the facade.
      run: async ({ operationId }) => {
        const { desktopApplication } = await import('./composition/application')
        const outcome = await desktopApplication.models.prepare('text', { operationId })
        if (!outcome.ok) throw new Error(outcome.failure.kind)
      }
    })
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
  //
  // Startup is an explicit dependency graph, not a chain of bare awaits. The first window used to
  // wait for an ONLINE licence revalidation and then for eleven sequential dynamic imports, and a
  // single throw anywhere in the block skipped every registration after it under one FATAL line.
  // Now: the required local steps run in order, the independent ones run together, each has a
  // deadline and a typed result, and nothing network-bound is waited on before the shell opens.
  installIpcDiagnostics(ipcMain)
  // Startup state is readable from the moment the window loads, because the window no longer waits
  // for startup to finish. Registered first so the renderer's very first question has an answer.
  applicationShutdown.register({
    name: 'startup:status-ipc',
    shutdown: registerStartupStatusIpc()
  })
  // Licensing first, from the CACHED entitlement: this is the local authorization decision, and
  // the SYNC `pro:is-enabled` handler must exist before createWindow() so the preload's sendSync
  // resolves and window.api.isPro reflects the real licence rather than a default. It is in the
  // minimum because of what it decides, not because it is cheap: private content must not reach a
  // window before the local decision about it exists.
  await runStartupStage({
    name: 'pro.entitlement.load-cached',
    deadlineMs: 5_000,
    domain: 'sync',
    required: true,
    // The clearest case for KEEPING a late effect. Refusing a licence decision that arrives slowly
    // would hold a paying user on the free build for the whole session, registering the provider
    // fills a single slot so it cannot create a second, and the licence-change notifier already
    // tells every window when entitlement moves.
    lateEffectIsRecoverable: true,
    run: () => loadProEntitlementProvider()
  })
  initLicensing()
  setupLicenseIpc()
  // One revalidation at a time, and its failure is recorded rather than dropped. `void` on a
  // promise discards a rejection, which for a periodic network call means a silent unhandled
  // rejection every time the mesh is unreachable; and a revalidation slower than the interval used
  // to have a second one started on top of it.
  let revalidating = false
  const entitlementRefresh = setInterval(() => {
    refreshCachedProEntitlement()
    if (revalidating) {
      writeDiagnosticLog('pro', 'entitlement.revalidate.skipped', { reason: 'in-flight' }, 'warn')
      return
    }
    revalidating = true
    revalidateProEntitlement('foreground')
      .catch((error: unknown) => {
        writeDiagnosticLog(
          'pro',
          'entitlement.revalidate.failed',
          { reason: 'foreground', error: error instanceof Error ? error.message : String(error) },
          'error'
        )
      })
      .finally(() => {
        revalidating = false
      })
  }, PERSONAL_MESH_ENTITLEMENT_REVALIDATION_INTERVAL_MS)
  entitlementRefresh.unref()
  applicationShutdown.register({
    name: 'pro:entitlement-refresh',
    shutdown: () => clearInterval(entitlementRefresh)
  })
  setupIPC()
  /**
   * CONSTRUCT the application, do not start it.
   *
   * Importing the composition root is what registers the application object, and that is what makes
   * every facade a handler reaches resolve instead of throwing "Desktop application is not
   * initialized". So the object is part of the minimum for a safe shell. STARTING its six domains
   * is not: that used to be a 20-second deadline in front of the window, and it now runs beside it,
   * with `startupProjection` carrying pending / degraded / failed to the renderer instead.
   */
  const applicationRoot = await runStartupStage({
    name: 'application.construct',
    deadlineMs: 10_000,
    required: true,
    // A module import cannot be cancelled, and its only module-scope effect is filling the single
    // slot the facade proxies read - so a late import produces a late-resolving application, never
    // a second one. What must not happen late is anything STARTING from it, and nothing can: every
    // consumer below is behind `applicationRoot.ok`.
    lateEffectIsRecoverable: true,
    run: () => import('./composition/application')
  })
  if (applicationRoot.ok) {
    applicationShutdown.register({
      name: 'startup:application-lifecycle',
      shutdown: startupProjection.observe(applicationRoot.value.desktopApplication)
    })
  }
  setupMcpIpc() // basic MCP connectors (management + chat tool extension)
  registerNativeActionTools(registerToolExtension) // the assistant's tools (macOS full set; Windows Outlook subset)
  setupDesktopBackupIPC()
  ipcMain.handle('media:url', (_e, absPath: string) => mediaUrlFor(absPath))
  // Nothing below depends on anything else below it: these are separate domains registering their
  // own handlers, so their import and setup latency is paid once, not eleven times over.
  await runIndependentStartupStages([
    {
      name: 'rag.ipc',
      deadlineMs: 10_000,
      domain: 'rag',
      run: ({ commit }) =>
        import('./rag-ipc').then(({ setupRagIPC }) => commit('rag.ipc.handlers', setupRagIPC))
    },
    {
      name: 'actions.ipc', // Approval UX v2: inline gate cards + outcome/undo feed
      deadlineMs: 10_000,
      domain: 'automation',
      run: ({ commit }) =>
        import('./actions/actions-ipc').then((m) =>
          commit('actions.ipc.handlers', m.registerActionsIpc)
        )
    },
    {
      name: 'browser.view.ipc', // dock the live browser view to the pane's region
      deadlineMs: 10_000,
      domain: 'use',
      run: ({ commit }) =>
        import('./browser/browser-host').then((m) =>
          commit('browser.view.ipc.handlers', m.registerBrowserViewIpc)
        )
    },
    {
      name: 'vision.ipc', // the vision rail's supervisor Stop/Pause/Resume
      deadlineMs: 10_000,
      domain: 'use',
      run: ({ commit }) =>
        import('./vision/vision-controller').then((m) =>
          commit('vision.ipc.handlers', m.registerVisionIpc)
        )
    },
    {
      name: 'vision.supervisor-window',
      deadlineMs: 10_000,
      domain: 'use',
      run: ({ commit }) =>
        import('./vision/supervisor-window').then((m) =>
          commit('vision.supervisor-window.handlers', m.registerSupervisorWindowIpc)
        )
    },
    {
      name: 'tasks.history.ipc', // one durable Web Use + Computer Use history
      deadlineMs: 10_000,
      domain: 'automation',
      run: ({ commit }) =>
        import('./tasks/task-history-ipc').then((m) =>
          commit('tasks.history.ipc.handlers', m.registerTaskHistoryIpc)
        )
    }
  ])

  // The shell. Everything above it is either the local authorization decision or the handler
  // registration that makes the window's own calls answerable - nothing network-bound, no domain
  // started, no data reconciled.
  createWindow()

  // Everything below runs BESIDE the open window. None of it may hold the shell closed: the
  // licence revalidation is network-bound, and the rest is optional or recoverable. Each one is
  // still bounded and each one's failure is observable - a background step is not a silent step.
  void runIndependentStartupStages([
    {
      // The six domains. Ordered ahead of nothing here - the stages in this list are independent -
      // but it is the one whose progress the renderer watches, through `startupProjection`. It
      // publishes its own degradation, hence no `domain`.
      name: 'application.start',
      deadlineMs: 20_000,
      required: true,
      // A late completion cannot start a second runtime - the composition root memoises the start
      // promise, so every call after the first resolves THAT one - and it cannot publish a false
      // ready either: the phase is read from the application's own status, and a stage settling
      // after its deadline is reported `late`, which is degradation, not readiness.
      lateEffectIsRecoverable: true,
      run: () =>
        applicationRoot.ok
          ? applicationRoot.value.startDesktopApplication()
          : Promise.reject(new Error('The application root could not be constructed.'))
    },
    {
      // Repair legacy catalog classifications before any runtime reads the active chat model.
      // A specialist such as Holo must never start as the normal text model after an upgrade.
      // Reconciliation of stored data, so it belongs beside the shell, not in front of it: chat
      // reads the active model through the models facade, which is pending until this settles.
      name: 'models.classification.reconcile',
      deadlineMs: 15_000,
      domain: 'models',
      run: async ({ signal }) => {
        const modelManager = await import('./models-manager')
        await modelManager.reconcileActiveModelClassification()
        // Two independent repairs. If the deadline passed during the first, the second is never
        // started: each one persists its own repair rather than replacing shared state, so the
        // guard that matters here is not BEGINNING more work after the stage was given up on.
        if (signal.aborted) return
        await modelManager.reconcileActiveModelProjector()
      }
    },
    {
      // The online licence check. The cached entitlement above already decided what this launch
      // is allowed to do; this confirms it, and expiry or revocation reaches every window through
      // the licence change notifier, which also shuts Pro features down. Enforcement is
      // unchanged - it is reactive rather than a precondition for opening a window.
      name: 'pro.entitlement.revalidate',
      deadlineMs: 30_000,
      domain: 'sync',
      // Same reasoning as the cached read: an entitlement answer that arrives late is kept, and
      // reaches every window through the licence-change notifier rather than through this stage.
      lateEffectIsRecoverable: true,
      run: () => revalidateProEntitlement('launch')
    },
    {
      // one OpenAI-compatible local gateway (LLM + STT); auto-picks a free port
      name: 'models.gateway.start',
      deadlineMs: 30_000,
      domain: 'models',
      // Same as the media server: a late listener is still owned by the shutdown registry
      // (`stopGateway`), so it cannot outlive the process untracked.
      lateEffectIsRecoverable: true,
      run: () => startModelServer()
    },
    {
      // Load the text model. Heavy and entirely optional to having a window: chat says so itself
      // when no model is ready.
      name: 'models.text.prepare',
      deadlineMs: 180_000,
      domain: 'models',
      // Loading a model cannot be cancelled, but the facade accepts an operation id, so a
      // superseded prepare is distinguishable from the current one at its owner.
      run: async ({ operationId }) => {
        const { desktopModels, modelsFailureMessage } =
          await import('./composition/application-access')
        const outcome = await desktopModels.prepare('text', { operationId })
        if (!outcome.ok) throw new Error(modelsFailureMessage(outcome.failure))
      }
    },
    {
      name: 'media.server.start', // loopback HTTP for seekable local media (meeting videos)
      deadlineMs: 10_000,
      // A late start still binds a listener, and that listener IS tracked: the shutdown registry
      // owns `stopMediaServer` from bootstrap, so quitting stops it whenever it came up.
      lateEffectIsRecoverable: true,
      run: async () => startMediaServer()
    },
    {
      // Pro features (capture, CRM, meetings, connectors, secretary, proactive, skills engine,
      // console, tray) register their own IPC + intervals/capture loop here. No-op in the free
      // build (the pro submodule is absent → stub).
      name: 'pro.features.load',
      deadlineMs: 30_000,
      // Activation is already single-owner where it matters: `loadProFeaturesMain` runs through
      // the Pro lifecycle queue, and its registry THROWS on a duplicate IPC channel or a duplicate
      // runtime owner. So a late completion cannot activate a second runtime; it is reported
      // `late` and its activation stands, because half-activated Pro would be worse than late Pro.
      lateEffectIsRecoverable: true,
      run: () => loadProFeaturesMain()
    },
    {
      // Update IPC is always registered (the renderer queries staged-version on startup in every
      // build); the auto-download engine runs production-only (dev has no feed).
      name: 'updater.ipc',
      deadlineMs: 15_000,
      // Registers IPC handlers AND starts the auto-download engine, so both go behind the guard:
      // a late completion must not add a second set of handlers or a second update engine.
      run: ({ commit }) =>
        import('./updater').then((m) =>
          commit('updater.ipc.handlers', () => {
            m.registerUpdateIpc()
            if (!is.dev) m.startAutoUpdates()
          })
        )
    }
  ])

  // Demo seeder for testing: OFFGRID_SEED=1 seeds once; OFFGRID_SEED=force re-seeds.
  if (process.env.OFFGRID_SEED) {
    void runStartupStage({
      name: 'dev.seed',
      deadlineMs: 120_000,
      // Writes demo rows, so a late completion must not seed a database the app has already
      // decided is unseeded.
      run: ({ commit }) =>
        import('./dev-seed').then((m) =>
          commit('dev.seed.write', () => m.seedDemo(process.env.OFFGRID_SEED === 'force'))
        )
    })
  }

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
    let readLifecycleFailure: (() => unknown) | null = null
    try {
      const { desktopApplication, stopDesktopApplication } =
        await import('./composition/application')
      readLifecycleFailure = () => desktopApplication.snapshot().lifecycleFailure
      await stopDesktopApplication()
    } catch (error) {
      console.error('[shutdown] application stop failed', readLifecycleFailure?.() ?? error)
    } finally {
      engineUnloaded = true
      // Buffered diagnostics are written now rather than lost with the process. Bounded, so a
      // stalled disk delays quit by at most the flush timeout.
      await flushDiagnosticLog()
      try {
        commitApplicationRelaunch(app)
      } finally {
        app.quit()
      }
    }
  })()
  void shutdownTask.catch((error) => console.error('[shutdown] quit failed', error))
})
