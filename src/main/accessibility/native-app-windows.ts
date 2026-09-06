import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { InstalledNativeApp, NativeAppPlatform } from './native-app-target'
import { UIA_APPS_SCRIPT, psQuote, uiaActivateScript } from './ax-uia-script'

const execFileAsync = promisify(execFile)
const INVENTORY_TTL_MS = 5 * 60_000
const START_APPS_SCRIPT = 'Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress'

let cachedInventory: { expiresAt: number; apps: InstalledNativeApp[] } | null = null

async function runPowerShell(script: string, timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }
  )
  return stdout
}

async function listInstalled(): Promise<InstalledNativeApp[]> {
  if (cachedInventory && cachedInventory.expiresAt > Date.now()) return cachedInventory.apps
  const parsed = JSON.parse(await runPowerShell(START_APPS_SCRIPT, 6_000)) as
    | { Name?: string; AppID?: string }
    | { Name?: string; AppID?: string }[]
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const apps = rows
    .filter((row) => Boolean(row.Name?.trim() && row.AppID?.trim()))
    .map((row) => ({ id: row.AppID!.trim(), name: row.Name!.trim() }))
  cachedInventory = { expiresAt: Date.now() + INVENTORY_TTL_MS, apps }
  return apps
}

export const windowsNativeAppPlatform: NativeAppPlatform = {
  async listRunning() {
    return (await runPowerShell(UIA_APPS_SCRIPT, 4_000))
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean)
  },
  listInstalled,
  async launch(app) {
    const target = `shell:AppsFolder\\${app.id}`
    await runPowerShell(
      `[System.Diagnostics.Process]::Start('explorer.exe', ${psQuote(target)}) | Out-Null`,
      5_000
    )
  },
  async activate(_app, runningName) {
    await runPowerShell(uiaActivateScript(runningName), 3_000)
  }
}
