import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resourceFile } from '../runtime-env'
import { parseAxElements, type AxSnapshot } from './ax-elements'
import type { AxBackend } from './ax-win'
import type { InstalledNativeApp, NativeAppPlatform } from './native-app-target'

const execFileAsync = promisify(execFile)

async function linuxAccessibility(operation: string, ...args: string[]): Promise<string> {
  const helper = resourceFile('linux-desktop/accessibility.py')
  if (!helper) throw new Error('The Linux accessibility helper is missing.')
  const { stdout } = await execFileAsync('/usr/bin/python3', [helper, operation, ...args], {
    timeout: operation === 'elements' ? 8_000 : 5_000,
    maxBuffer: 4 * 1024 * 1024
  })
  return stdout
}

export const linuxAxBackend: AxBackend = {
  available: () => process.platform === 'linux' && resourceFile('linux-desktop/accessibility.py') !== null,
  async listApps(): Promise<string[]> {
    try {
      return (await linuxAccessibility('apps')).split(/\r?\n/).map((name) => name.trim()).filter(Boolean)
    } catch {
      return []
    }
  },
  async snapshot(app: string): Promise<AxSnapshot | null> {
    try {
      const snapshot = parseAxElements(await linuxAccessibility('elements', app))
      return snapshot.windowTitle ? snapshot : null
    } catch {
      return null
    }
  }
}

export const linuxNativeAppPlatform: NativeAppPlatform = {
  listRunning: () => linuxAxBackend.listApps(),
  async listInstalled(): Promise<InstalledNativeApp[]> {
    try {
      return JSON.parse(await linuxAccessibility('installed')) as InstalledNativeApp[]
    } catch {
      return []
    }
  },
  async launch(app): Promise<void> {
    if (app.id.startsWith('running:')) return
    const launched = JSON.parse(await linuxAccessibility('launch', app.id)) as boolean
    if (!launched) throw new Error(`Could not open ${app.name}.`)
  },
  async activate(_app, runningName): Promise<void> {
    const activated = JSON.parse(await linuxAccessibility('activate', runningName)) as boolean
    if (!activated) throw new Error(`Could not focus ${runningName}.`)
  }
}

export async function resolveLinuxDefaultBrowser(): Promise<InstalledNativeApp | null> {
  try {
    return JSON.parse(await linuxAccessibility('default-browser')) as InstalledNativeApp | null
  } catch {
    return null
  }
}

export async function setLinuxAccessibleValue(
  app: string,
  x: number,
  y: number,
  value: number
): Promise<void> {
  let changed: boolean
  try {
    changed = JSON.parse(
      await linuxAccessibility('set-value', app, String(x), String(y), String(value))
    ) as boolean
  } catch {
    throw new Error('Native value control is unavailable.')
  }
  if (!changed) throw new Error('The Linux value control could not be set.')
}
