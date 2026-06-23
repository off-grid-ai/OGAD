import { app, shell, BrowserWindow, systemPreferences, protocol, net, session, desktopCapturer, screen, ipcMain } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import fs from 'fs'

// Custom scheme to serve local capture screenshots to the renderer (file:// is
// blocked there). Registered before app 'ready'; handled after.
protocol.registerSchemesAsPrivileged([
  { scheme: 'ogcapture', privileges: { secure: true, supportFetchAPI: true, bypassCSP: true, stream: true } },
])
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { setupIPC } from './ipc' // IMPORT FROM IPC ONLY
import { setupRagIPC } from './rag-ipc'
import { setupCrmIPC } from './crm-ipc'
import { startFocusLoop, setCapturePaused, isCapturePaused, getActiveAppName } from './focus'
import { startMeetingDetector } from './meeting-detect'
import { recoverOrphanedMeetings } from './meetings'
import { recoverOrphanTempDirs } from './meeting-native'
import { startModelServer } from './model-server'
import { runBackfill } from './search'
import { proposeActions } from './crm/agent'
import { syncAllConnectors } from './ingest'
import { learnIdentityFromGoogle } from './google-rest'
import { clearLayout } from './crm/layout'
import { Tray, Menu, nativeImage } from 'electron'
import { Watcher } from './watcher'
import { purgeLegacyChatImports } from './database'
import { migrateCrm } from './crm/schema'

// Pin one canonical userData dir ("Off Grid AI Desktop") regardless of package
// name, and migrate data from the legacy split dirs ("My Memories" had the
// models, "my-memories" had the DB) so nothing is lost / re-downloaded. Must run
// before app 'ready' and before any getPath('userData') usage.
;(function unifyUserDataPath(): void {
  try {
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
    console.log('[userData] canonical path:', canonical)
  } catch (e) {
    console.error('[userData] unify failed', e)
  }
})()

// FORCE UPDATE VERIFICATION: 3 - SHELL OVERWRITE
console.log("MAIN PROCESS: LOADING CUSTOM ENTRY POINT (SHELL OVERWRITE)");

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false, // REQUIRED for IPC
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
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
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Menu-bar (Tray) control surface for the always-on capture: pause/resume +
// recalibrate the learned per-app layouts.
let tray: Tray | null = null
let meetingRecording = false
let trayRebuild: (() => void) | null = null
function setupTray(): void {
  try {
    // Use the green Off Grid chip logo (kept in color — NOT a template image, so
    // the menu bar shows the brand mark, not a black silhouette).
    let img = nativeImage.createFromPath(icon)
    if (!img.isEmpty()) img = img.resize({ width: 18, height: 18 })
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
    const rebuild = (): void => {
      const paused = isCapturePaused()
      const active = getActiveAppName()
      tray?.setToolTip(meetingRecording ? 'Off Grid — recording meeting' : paused ? 'Off Grid — capture paused' : 'Off Grid — capturing')
      tray?.setContextMenu(
        Menu.buildFromTemplate([
          ...(meetingRecording
            ? [
                { label: '🔴 Recording meeting…', enabled: false },
                { label: 'Stop recording', click: () => { BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('meeting:stop')) } },
                { type: 'separator' as const },
              ]
            : []),
          { label: paused ? 'Capture: paused' : 'Capture: on', enabled: false },
          { type: 'separator' },
          { label: paused ? 'Resume capture' : 'Pause capture', click: () => { setCapturePaused(!paused); rebuild() } },
          {
            // Recalibrate just the app the user is currently in — the common case
            // ("this app's capture looks wrong, re-learn it now").
            label: active ? `Recalibrate “${active}”` : 'Recalibrate current app',
            enabled: !!active,
            click: () => { if (active) clearLayout(active) },
          },
          { label: 'Recalibrate all apps', click: () => clearLayout() },
          { type: 'separator' },
          {
            label: 'Open Off Grid',
            click: () => {
              const w = BrowserWindow.getAllWindows()[0]
              w?.show(); w?.focus()
            },
          },
          { label: 'Quit', click: () => app.quit() },
        ])
      )
    }
    trayRebuild = rebuild
    rebuild()
    // Keep the "current app" label fresh so opening the menu shows the right app.
    setInterval(rebuild, 4000)
  } catch (e) {
    console.error('[tray] setup failed', e)
  }
}

app.whenReady().then(() => {
  console.log("APP READY: Initializing Services...");

  // One-time, idempotent cleanup of the old "My Memories" AI-chat imports
  // (Claude/ChatGPT/Gemini scrapes + derived memories/entities/profile). crm
  // schema first so the orphan check can see observation_entities links.
  try { migrateCrm(); } catch (e) { console.warn('[startup] crm migrate failed', e); }
  try { purgeLegacyChatImports(); } catch (e) { console.warn('[startup] legacy purge failed', e); }

  // Dock icon = the Off Grid green chip logo (in dev macOS otherwise shows the
  // default Electron icon; the packaged build uses build/icon from electron-builder).
  if (process.platform === 'darwin' && app.dock) {
    try {
      const dockImg = nativeImage.createFromPath(icon)
      if (!dockImg.isEmpty()) app.dock.setIcon(dockImg)
    } catch (e) {
      console.warn('[dock] setIcon failed', e)
    }
  }

  // Serve local capture screenshots + entity photos + meeting videos to the
  // renderer. Delegate to Electron's native file handler (net.fetch on a file://
  // URL) — it implements HTTP range/seek for large media correctly, which the
  // hand-rolled stream did not (long recordings would stall or jump to the end).
  protocol.handle('ogcapture', async (request) => {
    const p = decodeURIComponent(request.url.slice('ogcapture://'.length));
    const range = request.headers.get('Range');
    try {
      const fileUrl = pathToFileURL(p).toString();
      const headers = new Headers();
      if (range) headers.set('Range', range);
      const resp = await net.fetch(fileUrl, { headers });
      console.log(`[ogcapture] ${p.split('/').pop()} range=${range || '(full)'} -> ${resp.status} cr=${resp.headers.get('content-range') || '-'} ct=${resp.headers.get('content-type') || '-'} len=${resp.headers.get('content-length') || '-'}`);
      return resp;
    } catch (e) {
      console.error('[ogcapture] serve failed for', p, e);
      return new Response(null, { status: 404 });
    }
  });

  // Meeting recorder: grant SYSTEM AUDIO (loopback) for getDisplayMedia so the
  // recorder can capture remote participants on macOS 13+ via ScreenCaptureKit.
  // Audio stays on device; this only fires when the renderer explicitly records.
  try {
    session.defaultSession.setDisplayMediaRequestHandler(
      async (_request, callback) => {
        try {
          const sources = await desktopCapturer.getSources({ types: ['screen'] });
          // Multi-monitor: record the display the user is actually on (cursor),
          // not an arbitrary sources[0].
          let pick = sources[0];
          try {
            const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
            const m = sources.find((s) => s.display_id === String(disp.id));
            if (m) pick = m;
          } catch {
            /* single display */
          }
          callback({ video: pick, audio: 'loopback' });
        } catch {
          callback({});
        }
      },
      { useSystemPicker: false }
    );
  } catch (e) {
    console.warn('[meetings] display-media handler setup failed', e);
  }

  // Grant microphone access for in-app voice input (STT). The OS still gates the
  // actual mic behind its own prompt (NSMicrophoneUsageDescription); this just
  // lets the renderer's getUserMedia request through Electron's permission layer.
  try {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media');
    });
  } catch (e) {
    console.warn('[voice] permission handler setup failed', e);
  }

  // Trigger permission prompt if not trusted
  if (process.platform === 'darwin') {
      const trusted = systemPreferences.isTrustedAccessibilityClient(true);
      console.log("Accessibility Permission:", trusted ? "Granted" : "Denied/Prompted");
  }

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })



  // 2. Setup IPC Handlers
  try {
     setupIPC();
     setupRagIPC();
     setupCrmIPC();
     startFocusLoop(); // get-windows-based focus capture (replaces the broken watcher path)
     startMeetingDetector(); // detect Zoom/Meet/Teams calls → auto-record
     // Renderer tells us when it's recording a meeting → reflect in the menu-bar tray.
     ipcMain.handle('meeting:set-recording', (_e, recording: boolean) => { meetingRecording = recording; trayRebuild?.(); });
     setupTray(); // menu-bar pause/recalibrate
     startModelServer(); // one OpenAI-compatible local gateway on :7878 (LLM + STT)
     // Adopt any recording whose transcription was interrupted by a restart so it
     // can never be lost. Delayed so it doesn't compete with startup; non-blocking.
     setTimeout(() => { void recoverOrphanedMeetings(); }, 8000);
     // Adopt recordings orphaned by a crash/restart mid-call (a separate recorder
     // process keeps writing to a temp dir after the app dies) — finalize + store.
     setTimeout(() => { void recoverOrphanTempDirs().catch((e) => console.error('[meetings] temp recover', e)); }, 10000);
     // Proactive loop: periodically PULL every connector (keep memory fresh), then
     // the secretary surveys tools + fresh context and proposes actions on its own
     // (no button). Proposals land in the approval queue and surface on the Day;
     // nothing executes unapproved. Webhooks aren't viable for a local app, so poll.
     const refreshAndPropose = async (): Promise<void> => {
       try { await syncAllConnectors(); } catch (e) { console.error('[autosync]', e); }
       try { await learnIdentityFromGoogle(); } catch (e) { console.error('[identity]', e); }
       try { const r = await proposeActions(Math.floor(Date.now() / 1000)); console.log('[secretary]', JSON.stringify(r)); } catch (e) { console.error('[secretary]', e); }
     };
     setTimeout(() => { void refreshAndPropose(); }, 60_000);
     setInterval(() => { void refreshAndPropose(); }, 30 * 60_000);
     // Backfill the semantic index (embed the observation/frame/transcript backlog
     // into LanceDB) so universal search has full NLP recall. Background + throttled.
     setTimeout(() => {
       void runBackfill((p) => { if (p.remaining % 200 === 0) console.log(`[search index] ${p.done} embedded, ${p.remaining} left`); })
         .catch((e) => console.error('[search index]', e));
     }, 20_000);
     console.log("IPC Handlers Registered.");
  } catch (e) {
     console.error("FATAL: IPC Setup failed", e);
  }

  // 3. Start Watcher
  try {
    Watcher.start();
    console.log("Watcher Service Started.");
  } catch (e) {
    console.error("Watcher Start Failed", e);
  }

  // 4. Initialize LLM (Async)
  // We don't await this to avoid blocking window creation
  import('./llm').then(({ llm }) => {
      llm.init().catch(err => console.error("Failed to init LLM:", err));
  });

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
