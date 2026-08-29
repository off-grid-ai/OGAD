import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import type { InstalledNativeApp, NativeAppPlatform } from './native-app-target'

const execFileAsync = promisify(execFile)
const MAC_APPLICATION_QUERY = "kMDItemContentType == 'com.apple.application-bundle'"
const INVENTORY_TTL_MS = 5 * 60_000

let cachedInventory: { expiresAt: number; apps: InstalledNativeApp[] } | null = null

async function runningAppNames(helper: string): Promise<string[]> {
  const { stdout } = await execFileAsync(helper, ['--apps'], { timeout: 4_000 })
  return stdout
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean)
}

async function bundleId(applicationPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/mdls',
      ['-raw', '-name', 'kMDItemCFBundleIdentifier', applicationPath],
      { timeout: 2_000 }
    )
    const value = stdout.trim()
    return value && value !== '(null)' ? value : null
  } catch {}
  try {
    const { stdout } = await execFileAsync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleIdentifier', path.join(applicationPath, 'Contents', 'Info.plist')],
      { timeout: 2_000 }
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function installedMacApps(): Promise<InstalledNativeApp[]> {
  if (cachedInventory && cachedInventory.expiresAt > Date.now()) return cachedInventory.apps
  const { stdout } = await execFileAsync('/usr/bin/mdfind', ['-0', MAC_APPLICATION_QUERY], {
    timeout: 6_000,
    maxBuffer: 4 * 1024 * 1024
  })
  const paths = stdout.split('\0').filter((item) => item.toLowerCase().endsWith('.app'))
  const byName = new Map<string, InstalledNativeApp>()
  for (const applicationPath of paths) {
    const name = path.basename(applicationPath, '.app').trim()
    if (!name || byName.has(name.toLowerCase())) continue
    // Resolve the bundle id only after goal matching. The path remains a safe
    // LaunchServices fallback when Spotlight omitted the metadata.
    byName.set(name.toLowerCase(), { id: applicationPath, name, launchRef: applicationPath })
  }
  const apps = [...byName.values()]
  cachedInventory = { expiresAt: Date.now() + INVENTORY_TTL_MS, apps }
  return apps
}

export function createMacNativeAppPlatform(helper: string): NativeAppPlatform {
  return {
    listRunning: () => runningAppNames(helper),
    listInstalled: installedMacApps,
    async identify(app) {
      const stableId = app.launchRef ? await bundleId(app.launchRef) : null
      return stableId ? { ...app, id: stableId } : app
    },
    async launch(app) {
      if (!app.id.startsWith('/')) {
        await execFileAsync('/usr/bin/open', ['-b', app.id], { timeout: 5_000 })
        return
      }
      await execFileAsync('/usr/bin/open', [app.launchRef ?? app.name], { timeout: 5_000 })
    },
    async activate(app, runningName) {
      // The display name can contain an invisible Unicode direction mark
      // (the current WhatsApp bundle does). LaunchServices activation by that
      // visible name then fails even though AX reports the running app. Prefer
      // the stable bundle identity resolved during discovery.
      if (!app.id.startsWith('/')) {
        await execFileAsync('/usr/bin/open', ['-b', app.id], { timeout: 3_000 })
        return
      }
      await execFileAsync('/usr/bin/open', ['-a', runningName], { timeout: 3_000 })
    }
  }
}
