import { app, BrowserWindow, protocol, session, desktopCapturer, screen } from 'electron'
import { tmpdir } from 'os'

import { restoreCanonicalProductName } from './bootstrap/user-data'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { setupIPC, startModelDownloadIpcProjection } from './ipc' // IMPORT FROM IPC ONLY
import { setupMcpIpc } from './mcp-ipc'
import { registerToolExtension } from './tools'
import { registerNativeActionTools } from './tools/nativeActionToolExtension'
import { setupDesktopBackupIPC } from './backup/ipc'
import { createMainWindow } from './create-main-window'
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

/**
 * THE text-model prepare stage. One definition for both the headless and the windowed start, so
 * neither can drift in deadline, domain or policy - and so the windowed start can hand its SETTLED
 * result to the demo seeder instead of the seeder issuing a prepare of its own. That duplicate used
 * to race this one and claim the newest-wins per-modality lane, refusing this stage as
 * `superseded`.
 *
 * `operationId` is a CORRELATION id: it ties this prepare to the started/succeeded/failed events it
 * emits, and nothing compares it to decide precedence. Supersession is shared's per-modality claim,
 * whatever ids either caller passed - which is why the fix is one owner, not a cleverer id.
 *
 * The late effect is declared KEPT because that is what happens: a model that finished loading
 * after the deadline IS resident, and unloading one the user may already be chatting with would be
 * worse. Residency and the active-model change happen inside shared; what this seat owns is saying
 * so.
 */
function runTextModelPrepareStage(): Promise<StartupStageResult<StartupTextModelState>> {
  return runStartupStage({
    // Heavy, and entirely optional to having a window: chat says so itself when no model is ready.
    name: 'models.text.prepare',
    deadlineMs: 180_000,
    domain: 'models',
    lateEffectIsRecoverable: true,
    run: async ({ operationId }) => {
      // Await the composition root MODULE, and take the facade from it. Not the
      // `application-access` proxy: that throws until the root has been registered, and this stage
      // runs concurrently with `application.start`, so relying on import microtask order would be
      // a race. Importing the root is also how it is constructed, and the module cache makes that
      // the one instance - so this depends on construction explicitly without creating a second.
      const { desktopApplication } = await import('./composition/application')
      const { modelsFailureMessage } = await import('./composition/application-access')
      const { prepareStartupTextModel } = await import('./startup-text-model')
      const outcome = await prepareStartupTextModel(desktopApplication.models, operationId)
      if (!outcome.ok) throw new Error(modelsFailureMessage(outcome.failure))
      // Returned so a caller can tell "startup succeeded" from "a model is loaded".
      return outcome.value
    }
  })
}

import {
  initLicensing,
  refreshCachedProEntitlement,
  revalidateProEntitlement
} from './licensing/license-service'
import { PERSONAL_MESH_ENTITLEMENT_REVALIDATION_INTERVAL_MS } from '@offgrid/sync'
import { setupLicenseIpc } from './license-ipc'
import { nativeImage } from 'electron'
import { purgeLegacyChatImports } from './database'
import { PRODUCT_NAME } from '../shared/product-identity'
import { installMediaPermissionHandler } from './media-permission'
import { localMediaRoots } from './media-roots'
import { resourceDirs } from './runtime-env'
import { runIndependentStartupStages, runStartupStage } from './startup-stages'
import type { StartupStageResult } from './startup-stages'
import type { StartupTextModelState } from './startup-text-model'
import { startupProjection } from './startup-projection'
import { registerStartupStatusIpc } from './startup-ipc'
import { observeWorkflowFailures } from './workflow-failure-observer'
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
  stopMediaServer
})

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

const applicationReady = app.whenReady().then(async () => {
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
    void runTextModelPrepareStage()
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
    /**
     * A module import cannot be cancelled, so its late effect is KEPT - and what makes that safe
     * is the module cache, not a guard of mine: evaluation happens at most once, so a late import
     * cannot register the handlers it sets up at module scope (the speech IPC among them) twice,
     * and cannot construct a second application. What must not happen late is anything STARTING
     * from it, and nothing can: every consumer below is behind `applicationRoot.ok`.
     */
    lateEffectIsRecoverable: true,
    run: async () => {
      const composition = await import('./composition/application')
      startModelDownloadIpcProjection(composition.desktopApplication.models)
      return composition
    }
  })
  if (applicationRoot.ok) {
    applicationShutdown.register({
      name: 'startup:application-lifecycle',
      shutdown: startupProjection.observe(applicationRoot.value.desktopApplication)
    })
    // The standing workflow bridges have no caller to fail to, so this subscription is the only
    // place their failures can surface. Registered with the application object, before its domains
    // start, so a bridge that fails during startup is not missed.
    applicationShutdown.register({
      name: 'workflows:failure-observer',
      shutdown: observeWorkflowFailures(applicationRoot.value.desktopApplication)
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
      // The voice question's caller. Registered beside the shell rather than in front of it: the
      // window can open before a voice turn is possible, and the projection says so.
      name: 'voice.ask-by-voice.ipc',
      deadlineMs: 10_000,
      domain: 'speech',
      run: ({ commit }) =>
        import('./ask-by-voice-ipc').then((m) =>
          commit('voice.ask-by-voice.handlers', () =>
            m.setupAskByVoiceIpc(async () => {
              const { desktopApplication } = await import('./composition/application')
              return desktopApplication
            })
          )
        )
    },
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
  createMainWindow(windowPresentation.showWindow)

  // Everything below runs BESIDE the open window. None of it may hold the shell closed: the
  // licence revalidation is network-bound, and the rest is optional or recoverable. Each one is
  // still bounded and each one's failure is observable - a background step is not a silent step.
  const textModelReady = runTextModelPrepareStage()

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
        // The signal goes INTO the repair, not just between the two: the classification repair
        // makes two persisted selection changes, so checking only after it returned let both of
        // them land after this stage had been given up on. It now refuses to begin them.
        await modelManager.reconcileActiveModelClassification(signal)
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
      run: async () => {
        if (!applicationRoot.ok) {
          throw new Error('The application root could not be constructed.')
        }
        // Pro Sync is an extension of the shared Sync facade, not a parallel runtime. Its launch
        // reconciliation can request discovery, so the shared application must finish its
        // memoised start first. The shell is already open; this only orders the two background
        // stages and cannot construct or start a second application.
        await applicationRoot.value.startDesktopApplication()
        await loadProFeaturesMain()
      }
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
  //
  // Sequenced AFTER the one text prepare settles, so its 120s deadline measures seeding rather than
  // a 180s model load. Readiness decides live vs curated artifacts; the rows seed either way, and
  // it never issues a prepare.
  if (process.env.OFFGRID_SEED) {
    void textModelReady.then((prepared) =>
      runStartupStage({
        name: 'dev.seed',
        deadlineMs: 120_000,
        // commit guards invocation, not the asynchronous writes inside the seeder. A started
        // seed may finish after the deadline; keep its durable fixture writes and report late.
        // Failure leaves the completion marker false; the next seed cleans its project before retry.
        lateEffectIsRecoverable: true,
        run: ({ commit }) =>
          import('./dev-seed').then((m) =>
            commit('dev.seed.write', () =>
              m.seedDemo(
                process.env.OFFGRID_SEED === 'force',
                // Generation needs a LOADED model: settled, actually prepared rather than
                // nothing-selected, and ready. `unconfigured` is a successful startup and still
                // not generation-capable.
                prepared.ok && prepared.value.kind === 'prepared' && prepared.value.active.ready
              )
            )
          )
      })
    )
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(windowPresentation.showWindow)
  })
  app.on('browser-window-focus', () => {
    refreshCachedProEntitlement()
    void revalidateProEntitlement('foreground')
  })
})
void applicationReady.catch((error: unknown) => {
  console.error('[startup] application initialization failed', error)
  app.quit()
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
