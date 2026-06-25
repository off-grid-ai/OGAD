import { app, shell, BrowserWindow, protocol, net, session, desktopCapturer, screen } from 'electron'
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
import { setupMcpIpc } from './mcp-ipc'
import { startModelServer } from './model-server'
import { loadProFeaturesMain } from './bootstrap/loadProFeaturesMain'
import { nativeImage } from 'electron'
import { purgeLegacyChatImports } from './database'

// Pin one canonical userData dir ("Off Grid AI Desktop") regardless of package
// name, and migrate data from the legacy split dirs ("My Memories" had the
// models, "my-memories" had the DB) so nothing is lost / re-downloaded. Must run
// before app 'ready' and before any getPath('userData') usage.
// Brand the app name as early as possible (before ready) so the menu bar, the
// about panel, and notifications read "Off Grid AI" rather than the Electron
// default. (In `electron-vite dev` the macOS Dock tooltip still reads "Electron"
// because that's the dev binary's bundle name; the packaged build's CFBundleName
// comes from electron-builder `productName`, so it's correct there.)
app.setName('Off Grid AI')

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
    title: 'Off Grid AI',
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

// The menu-bar (Tray) control surface for always-on capture (pause/resume +
// recalibrate) is a pro feature — pro's activateMain builds it. The free build
// has no tray.

// Only one instance may run: a second instance would share os.tmpdir() and the
// meetings DB, so its orphan-recovery could adopt/kill the first instance's LIVE
// recorder. Bail before whenReady if we can't get the lock; focus the existing
// window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(() => {
  // Server-only (headless) mode: boot just the multimodal gateway + LLM runtime,
  // no window / tray / capture / CRM loops. Lets the gateway be deployed on its
  // own — `<app-binary> --server-only` (or OFFGRID_SERVER_ONLY=1) — while still
  // reusing the Electron-built native binaries. First step toward a standalone
  // gateway CLI (see docs/GATEWAY_SPINE.md "externalize later").
  const serverOnly = process.argv.includes('--server-only') || process.env.OFFGRID_SERVER_ONLY === '1';
  if (serverOnly) {
    console.log('[gateway] server-only mode — gateway on :7878, no UI/capture');
    if (process.platform === 'darwin' && app.dock) { try { app.dock.hide(); } catch { /* ignore */ } }
    try { startModelServer(); } catch (e) { console.error('[gateway] start failed', e); }
    void import('./llm').then(({ llm }) => llm.init().catch((err) => console.error('[gateway] LLM init failed', err)));
    return; // skip window, tray, watcher, IPC, capture, connectors — gateway only
  }

  console.log("APP READY: Initializing Services...");

  // One-time, idempotent cleanup of the old "My Memories" AI-chat imports.
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

  // NOTE: Accessibility is a Pro (capture) permission — the free build never asks
  // for it. Pro requests it when capture starts (see pro focus/watcher).

  // Set app user model id for Windows notifications/taskbar grouping.
  electronApp.setAppUserModelId('co.getoffgridai.desktop')

  // Native About panel branding (macOS / Linux).
  try {
    app.setAboutPanelOptions({
      applicationName: 'Off Grid AI',
      applicationVersion: app.getVersion(),
      copyright: 'Off Grid AI — private, on-device AI',
      website: 'https://getoffgridai.co',
    })
  } catch { /* not supported on this platform */ }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })



  // 2. Setup IPC Handlers (core) + the local model gateway
  try {
     setupIPC();
     setupRagIPC();
     setupMcpIpc(); // basic MCP connectors (management + chat tool extension)
     startModelServer(); // one OpenAI-compatible local gateway on :7878 (LLM + STT)
     // Pro features (capture, CRM, meetings, connectors, secretary, proactive,
     // skills engine, console, tray) register their own IPC + intervals + watchers
     // here. No-op in the free build (the pro submodule is absent → stub).
     void loadProFeaturesMain().catch((e) => console.error('[pro] load failed', e));
     // Demo seeder for testing: OFFGRID_SEED=1 seeds once; OFFGRID_SEED=force re-seeds.
     if (process.env.OFFGRID_SEED) {
       void import('./dev-seed').then((m) => m.seedDemo(process.env.OFFGRID_SEED === 'force')).catch((e) => console.error('[seed]', e));
     }
     console.log("IPC Handlers Registered.");
  } catch (e) {
     console.error("FATAL: IPC Setup failed", e);
  }

  // 3. Initialize LLM (Async)
  // We don't await this to avoid blocking window creation
  import('./llm').then(({ llm }) => {
      llm.init().catch(err => console.error("Failed to init LLM:", err));
  });

  createWindow()

  // Auto-update from GitHub Releases (production only; dev has no update feed).
  if (!is.dev) {
    import('./updater').then((m) => m.startAutoUpdates()).catch((e) => console.error('[update] init', e))
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
