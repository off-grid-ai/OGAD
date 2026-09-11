import { restoreCanonicalProductName } from './bootstrap/user-data'
import { app, shell, BrowserWindow, protocol, session, desktopCapturer, screen } from 'electron'
import { tmpdir } from 'os'

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
import { purgeLegacyChatImports, getSetting } from './database'
import { modalityQueue } from './modality-queue/queue'
import { applyQueueConfig, readQueueConfig } from './modality-queue/config'
import { registerRuntime } from './runtime-manager'
import { guardConsoleStreams } from './stream-guards'
import { PRODUCT_NAME } from '../shared/product-identity'
import { installMediaPermissionHandler } from './media-permission'
import { localMediaRoots } from './media-roots'
import { resourceDirs } from './runtime-env'
import {
  installDiagnosticConsoleCapture,
  installIpcDiagnostics,
  writeDiagnosticLog
} from './diagnostics-log'
import { registerStartupStatusIpc } from './startup-ipc'
import { runIndependentStartupStages, runStartupStage } from './startup-stages'
import {
  applicationShutdown,
  commitApplicationRelaunch,
  installApplicationShutdown,
  registerCoreShutdownOwners
} from './shutdown'
import { shutdownRuntimes } from './runtime-manager'
import { shutdownModelDownloads } from './models/download-queue'

// Before anything logs: a broken stdout/stderr pipe (parent/e2e-harness exited, closed pipe)
// must never crash main via an uncaught EPIPE. See stream-guards.ts.
guardConsoleStreams([process.stdout, process.stderr])

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
  stopModelRuntimes: shutdownRuntimes,
  stopModelDownloads: shutdownModelDownloads
})

// FORCE UPDATE VERIFICATION: 3 - SHELL OVERWRITE
console.log('MAIN PROCESS: LOADING CUSTOM ENTRY POINT (SHELL OVERWRITE)')

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

  // Pin zoom to 100% (clear any persisted accidental Cmd+= zoom) and disable
  // pinch-zoom so the UI always renders at the intended density.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.setZoomFactor(1)
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
    void import('./llm').then(({ llm }) =>
      llm.init().catch((err) => console.error('[gateway] LLM init failed', err))
    )
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

  installIpcDiagnostics(ipcMain)
  applicationShutdown.register({
    name: 'startup:status-ipc',
    shutdown: registerStartupStatusIpc()
  })

  // The cached entitlement is the only asynchronous decision that must precede the shell. It is
  // local and fail-closed: if it misses the bound, Pro stays unavailable until the provider lands.
  await runStartupStage({
    name: 'pro.entitlement.load-cached',
    deadlineMs: 5_000,
    required: true,
    lateEffect: 'keep',
    run: () => loadProEntitlementProvider()
  })
  initLicensing()
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

  await runStartupStage({
    name: 'core.ipc',
    deadlineMs: 10_000,
    required: true,
    lateEffect: 'guard',
    run: ({ commit }) =>
      commit('core.ipc.handlers', () => {
        setupIPC()
        setupRagIPC()
        setupMcpIpc()
        registerNativeActionTools(registerToolExtension)
        setupDesktopBackupIPC()
        ipcMain.handle('media:url', (_event, absPath: string) => mediaUrlFor(absPath))
      })
  })

  // These registrations are independent. They load together, and each failure remains isolated.
  await runIndependentStartupStages([
    {
      name: 'actions.ipc',
      deadlineMs: 10_000,
      lateEffect: 'guard',
      run: ({ commit }) =>
        import('./actions/actions-ipc').then((module) =>
          commit('actions.ipc.handlers', module.registerActionsIpc)
        )
    },
    {
      name: 'browser.view.ipc',
      deadlineMs: 10_000,
      lateEffect: 'guard',
      run: ({ commit }) =>
        import('./browser/browser-host').then((module) =>
          commit('browser.view.ipc.handlers', module.registerBrowserViewIpc)
        )
    },
    {
      name: 'vision.ipc',
      deadlineMs: 10_000,
      lateEffect: 'guard',
      run: ({ commit }) =>
        import('./vision/vision-controller').then((module) =>
          commit('vision.ipc.handlers', module.registerVisionIpc)
        )
    },
    {
      name: 'vision.supervisor-window',
      deadlineMs: 10_000,
      lateEffect: 'guard',
      run: ({ commit }) =>
        import('./vision/supervisor-window').then((module) =>
          commit('vision.supervisor-window.handlers', module.registerSupervisorWindowIpc)
        )
    },
    {
      name: 'tasks.history.ipc',
      deadlineMs: 10_000,
      lateEffect: 'guard',
      run: ({ commit }) =>
        import('./tasks/task-history-ipc').then((module) =>
          commit('tasks.history.ipc.handlers', module.registerTaskHistoryIpc)
        )
    }
  ])

  createWindow()

  // Network checks, model work, and optional services now run beside the visible shell.
  void runIndependentStartupStages([
    {
      name: 'pro.entitlement.revalidate',
      deadlineMs: 30_000,
      lateEffect: 'keep',
      run: () => revalidateProEntitlement('launch')
    },
    {
      name: 'models.gateway.start',
      deadlineMs: 30_000,
      lateEffect: 'keep',
      run: () => startModelServer()
    },
    {
      name: 'media.server.start',
      deadlineMs: 10_000,
      lateEffect: 'keep',
      run: () => startMediaServer()
    },
    {
      name: 'models.text.prepare',
      deadlineMs: 180_000,
      lateEffect: 'keep',
      run: async () => {
        const { llm } = await import('./llm')
        registerRuntime(llm.runtime)
        applyQueueConfig(modalityQueue, readQueueConfig(getSetting))
        if (llm.modelsExist()) await llm.init()
      }
    },
    {
      name: 'modalities.runtime.register',
      deadlineMs: 30_000,
      lateEffect: 'guard',
      run: async ({ commit }) => {
        const [{ ttsRuntime }, { imageRuntime }, { sttRuntime }] = await Promise.all([
          import('./tts'),
          import('./imagegen'),
          import('./transcription/select')
        ])
        commit('modalities.runtime.registrations', () => {
          registerRuntime(ttsRuntime)
          registerRuntime(imageRuntime)
          registerRuntime(sttRuntime)
        })
      }
    },
    {
      name: 'models.projector.reconcile',
      deadlineMs: 15_000,
      lateEffect: 'keep',
      run: () => import('./models-manager').then((module) => module.reconcileActiveModelProjector())
    },
    {
      name: 'pro.features.load',
      deadlineMs: 30_000,
      lateEffect: 'keep',
      run: () => loadProFeaturesMain()
    },
    {
      name: 'updater.ipc',
      deadlineMs: 15_000,
      lateEffect: 'guard',
      run: ({ commit }) =>
        import('./updater').then((module) =>
          commit('updater.ipc.handlers', () => {
            module.registerUpdateIpc()
            if (!is.dev) module.startAutoUpdates()
          })
        )
    }
  ])

  // Demo seeding already runs beside the shell. Keep its existing persistence semantics instead of
  // pretending an in-progress database write can be cancelled by a timer.
  if (process.env.OFFGRID_SEED) {
    void import('./dev-seed')
      .then((module) => module.seedDemo(process.env.OFFGRID_SEED === 'force'))
      .catch((error) => console.error('[seed]', error))
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
app.on('before-quit', (event) => {
  if (engineUnloaded) {
    return
  }
  event.preventDefault()
  void (async () => {
    // Stop the agent browser first so a playing video's audio dies immediately,
    // not whenever the process finally exits.
    try {
      const { disposeBrowserHost } = await import('./browser/browser-host')
      disposeBrowserHost()
    } catch {
      /* best-effort — never block quit */
    }
    try {
      const { llm } = await import('./llm')
      await llm.unload()
    } catch {
      /* best-effort — quit regardless so the app never hangs on exit */
    }
    engineUnloaded = true
    commitApplicationRelaunch(app)
    app.quit()
  })()
})
