import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { InstalledNativeApp, NativeAppPlatform } from './native-app-target'
import { UIA_APPS_SCRIPT, psQuote, uiaActivateScript } from './ax-uia-script'

const execFileAsync = promisify(execFile)
const INVENTORY_TTL_MS = 5 * 60_000
const START_APPS_SCRIPT = 'Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress'
const DEFAULT_BROWSER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$choice = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice'
$progId = $choice.ProgId
if (-not $progId) { exit 1 }
$commandKey = Get-Item ('Registry::HKEY_CLASSES_ROOT\\' + $progId + '\\shell\\open\\command')
$command = [string]$commandKey.GetValue('')
if ($command -match '^\\s*"([^"]+\\.exe)"' -or $command -match '^\\s*([^\\s]+\\.exe)') {
  $executable = $Matches[1]
} else { exit 1 }
$file = Get-Item $executable
$name = $file.VersionInfo.ProductName
if (-not $name) { $name = $file.VersionInfo.FileDescription }
if (-not $name) { $name = $file.BaseName }
[ordered]@{ id=$progId; name=$name; launchRef=$file.FullName } | ConvertTo-Json -Compress
`.trim()

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

export async function resolveWindowsDefaultBrowser(): Promise<InstalledNativeApp | null> {
  try {
    const browser = JSON.parse(await runPowerShell(DEFAULT_BROWSER_SCRIPT, 4_000)) as {
      id?: unknown
      name?: unknown
      launchRef?: unknown
    }
    if (
      typeof browser.id !== 'string' ||
      !browser.id.trim() ||
      typeof browser.name !== 'string' ||
      !browser.name.trim() ||
      typeof browser.launchRef !== 'string' ||
      !browser.launchRef.trim()
    ) {
      return null
    }
    return {
      id: browser.id.trim(),
      name: browser.name.trim(),
      launchRef: browser.launchRef.trim()
    }
  } catch {
    return null
  }
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
    if (app.launchRef) {
      await runPowerShell(
        `[System.Diagnostics.Process]::Start(${psQuote(app.launchRef)}) | Out-Null`,
        5_000
      )
      return
    }
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
