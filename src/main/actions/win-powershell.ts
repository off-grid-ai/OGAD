/**
 * Electron-bound PowerShell runner for the Windows semantic rail. The one
 * seam every Outlook COM script goes through - mirrors native-helper.ts on
 * macOS, and speaks the same one-JSON-line contract, parsed by the same
 * parseHelperResponse. Never throws: a spawn failure, a timeout, or a
 * script error all resolve to a reported { ok: false }.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { parseHelperResponse, type NativeActionResponse } from './native-helper-logic'

const execFileAsync = promisify(execFile)

export async function runPowerShell(script: string): Promise<NativeActionResponse> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { maxBuffer: 8 * 1024 * 1024, timeout: 20_000, windowsHide: true }
    )
    return parseHelperResponse(stdout)
  } catch (e) {
    // A non-zero exit may still have printed a response line - prefer it.
    const stdout = (e as { stdout?: string }).stdout
    if (typeof stdout === 'string' && stdout.trim().length > 0) {
      return parseHelperResponse(stdout)
    }
    return { ok: false, error: (e as Error).message }
  }
}
