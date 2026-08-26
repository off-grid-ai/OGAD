/**
 * The Windows accessibility backend - the counterpart of the macOS Swift helper,
 * driving the exact same AxBackend contract so ax-host's routing + element loop
 * run unchanged per platform. It shells to PowerShell + UI Automation (see
 * ax-uia-script.ts), mirroring the Windows semantic rail's PowerShell approach -
 * no compiled binary to build or ship.
 *
 * Every call is fail-closed: a spawn error, a timeout, or a PowerShell fault
 * resolves to [] / null / a no-op, so a missing or dead UIA read makes the router
 * fall through to the vision rail rather than throwing.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseAxElements, type AxSnapshot } from './ax-elements'
import { UIA_APPS_SCRIPT, uiaActivateScript, uiaElementsScript } from './ax-uia-script'

const execFileAsync = promisify(execFile)

/** Run a PowerShell script and return its raw stdout (never throws to the caller
 *  here - callers decide the fail-closed value). The script is passed as a single
 *  argv (no shell), so only its own PowerShell parsing applies. */
async function runPowerShellRaw(script: string, timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }
  )
  return stdout
}

export interface AxBackend {
  /** True when this platform's accessibility read is usable at all. */
  available(): boolean
  /** Foreground-windowed apps the user could name (display names). */
  listApps(): Promise<string[]>
  /** Bring the target app forward so synthetic input lands on it. */
  activate(app: string): Promise<void>
  /** Read the target app's interactive elements, or null on any failure. */
  snapshot(app: string): Promise<AxSnapshot | null>
}

export const windowsAxBackend: AxBackend = {
  available(): boolean {
    return process.platform === 'win32'
  },
  async listApps(): Promise<string[]> {
    try {
      return (await runPowerShellRaw(UIA_APPS_SCRIPT, 4_000))
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    } catch {
      return []
    }
  },
  async activate(app: string): Promise<void> {
    try {
      await runPowerShellRaw(uiaActivateScript(app), 3_000)
    } catch {
      /* best effort - a miss just means it was already frontmost / not resolvable */
    }
  },
  async snapshot(app: string): Promise<AxSnapshot | null> {
    try {
      return parseAxElements(await runPowerShellRaw(uiaElementsScript(app), 6_000))
    } catch {
      return null
    }
  }
}
