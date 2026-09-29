// Host-agnostic path/resource resolution for the gateway runtime.
//
// The runtime (llm, imagegen, tts, embeddings, active-models, model-server,
// rag/extractors, mflux) must run BOTH embedded in Electron AND standalone
// (the future @offgrid/gateway: a Node CLI / Docker image). This is the single
// seam that hides where data + bundled binaries live, so none of those modules
// import `electron` directly.
//
// Resolution order: explicit configure() → env vars → Electron `app` → cwd.
import path from 'path'
import fs from 'fs'
import { createRequire } from 'module'

const loadOptionalModule = createRequire(import.meta.url)

interface OptionalElectronApp {
  getPath?: (name: 'userData') => string
  getAppPath?: () => string
  isPackaged?: boolean
}

function optionalElectronApp(): OptionalElectronApp | undefined {
  return (loadOptionalModule('electron') as { app?: OptionalElectronApp }).app
}

interface RuntimeConfig {
  dataDir?: string // writable per-user dir (models, caches, generated output)
  binRoots?: string[] // dirs to search for bundled binaries (llama-server, ffmpeg, …)
  resourceDirs?: string[] // dirs to search for bundled resources (tts-worker.mjs, …)
}

let cfg: RuntimeConfig = {}

function developmentBinRoots(root: string): string[] {
  return process.platform === 'linux'
    ? [path.join(root, 'build', 'linux-bin'), path.join(root, 'resources', 'bin')]
    : [path.join(root, 'resources', 'bin')]
}

/** Host calls this once at startup. Electron host passes app paths; a standalone
 *  host passes its own. Any field left out falls back to env/electron/cwd. */
export function configureRuntime(c: RuntimeConfig): void {
  cfg = { ...cfg, ...c }
}

// Lazily probe Electron without a hard dependency (so the module loads in plain Node).
function electron(): { dataDir: string; binRoots: string[]; resourceDirs: string[] } | null {
  try {
    const app = optionalElectronApp()
    if (!app?.getPath) return null
    const packaged = app.isPackaged === true
    return {
      dataDir: app.getPath('userData'),
      binRoots: packaged
        ? [path.join(process.resourcesPath, 'bin')]
        : [
            ...developmentBinRoots(app.getAppPath?.() ?? process.cwd()),
            ...developmentBinRoots(process.cwd())
          ],
      resourceDirs: packaged
        ? [process.resourcesPath]
        : [
            path.join(app.getAppPath?.() ?? process.cwd(), 'resources'),
            path.join(process.cwd(), 'resources')
          ]
    }
  } catch {
    return null
  }
}

/** Writable per-user data dir (models, caches, generated images, settings). */
export function dataDir(): string {
  if (cfg.dataDir) return cfg.dataDir
  if (process.env.OFFGRID_DATA_DIR) return process.env.OFFGRID_DATA_DIR
  const e = electron()
  if (e) return e.dataDir
  return path.join(process.cwd(), '.offgrid')
}

/** The models directory under the data dir. */
export function modelsDir(): string {
  return path.join(dataDir(), 'models')
}

/** Dirs to search for bundled binaries (binary lives under one of these). */
export function binRoots(): string[] {
  if (cfg.binRoots?.length) return cfg.binRoots
  if (process.env.OFFGRID_BIN_DIR) return [process.env.OFFGRID_BIN_DIR]
  const e = electron()
  const bundledRoots = e?.binRoots ?? developmentBinRoots(process.cwd())
  const performancePack = process.env.OFFGRID_PERFORMANCE_PACK_BIN
  return performancePack ? [performancePack, ...bundledRoots] : bundledRoots
}

/** Append the platform executable extension to a bundled binary's base name:
 *  `.exe` on Windows, nothing on macOS/Linux. Use this at every spawn site so
 *  `llama-server` resolves to `llama-server.exe` on win32. */
export function exe(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name
}

/** Resolve a bundled resource file by name across the resource dirs, or null. */
export function resourceFile(name: string): string | null {
  for (const d of resourceDirs()) {
    const p = path.join(d, name)
    try {
      if (fs.existsSync(p)) return p
    } catch {
      /* ignore */
    }
  }
  return null
}

export interface ApplicationCodeLocation {
  packagedAppPath: string | null
  packagedName: string
  developmentName: string
  developmentDirs: string[]
}

/** Pure trust rule used by applicationCodeFile and its security regression test. */
export function resolveApplicationCodeFile(location: ApplicationCodeLocation): string | null {
  const candidates = location.packagedAppPath
    ? [path.join(location.packagedAppPath, 'out', 'main', location.packagedName)]
    : location.developmentDirs.map((dir) => path.join(dir, location.developmentName))
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* keep looking */
    }
  }
  return null
}

/** Resolve executable application code. A packaged Electron host must never honor
 * environment/config resource overrides here: that would let external JavaScript
 * bypass the integrity-checked ASAR. Development and standalone hosts keep the
 * ordinary resource override seam. */
export function applicationCodeFile(packagedName: string, developmentName: string): string | null {
  try {
    const app = optionalElectronApp()
    if (app?.isPackaged === true) {
      return resolveApplicationCodeFile({
        packagedAppPath: app.getAppPath?.() ?? null,
        packagedName,
        developmentName,
        developmentDirs: []
      })
    }
  } catch {
    /* development or standalone host */
  }
  return resolveApplicationCodeFile({
    packagedAppPath: null,
    packagedName,
    developmentName,
    developmentDirs: resourceDirs()
  })
}

/** Whether running inside a packaged app (affects quarantine handling on macOS). */
export function isPackaged(): boolean {
  if (process.env.OFFGRID_PACKAGED) return process.env.OFFGRID_PACKAGED === '1'
  try {
    return optionalElectronApp()?.isPackaged === true
  } catch {
    return false
  }
}

/** Dirs to search for bundled resources (e.g. tts-worker.mjs). */
export function resourceDirs(): string[] {
  if (cfg.resourceDirs?.length) return cfg.resourceDirs
  if (process.env.OFFGRID_RESOURCE_DIR) return [process.env.OFFGRID_RESOURCE_DIR]
  const e = electron()
  if (e) return e.resourceDirs
  return [path.join(process.cwd(), 'resources')]
}
