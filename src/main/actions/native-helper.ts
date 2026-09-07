// Electron-bound invoker for the native actions helper (macOS). Resolves the compiled
// helper binary and runs it as a one-shot child process, handing it one JSON command
// and parsing the one JSON line it prints back. This is the single seam every semantic
// native capability (calendar, reminders, contacts, photos) goes through, so the
// process/permission handling lives in one place. Mirrors ocr.ts.

import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import { app } from 'electron'
import {
  helperBinCandidates,
  parseHelperResponse,
  serializeCommand,
  type NativeActionCommand,
  type NativeActionResponse
} from './native-helper-logic'

const execFileAsync = promisify(execFile)

function helperBin(): string | null {
  const candidates = helperBinCandidates({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    cwd: process.cwd(),
    appPath: app.getAppPath()
  })
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

/** Run one native action. Never throws: a missing helper, a spawn failure, a timeout,
 *  or a handled in-band error all resolve to an { ok: false } response so callers
 *  (tools, the approval executor) have a single shape to report. */
export async function runNativeAction(cmd: NativeActionCommand): Promise<NativeActionResponse> {
  const bin = helperBin()
  if (!bin) {
    return { ok: false, error: 'the native actions helper is not available in this build' }
  }
  try {
    const { stdout } = await execFileAsync(bin, [serializeCommand(cmd)], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 20_000
    })
    return parseHelperResponse(stdout)
  } catch (e) {
    // execFile rejects on a non-zero exit, a timeout, or a spawn failure. The helper
    // exits 0 even on handled errors, so reaching here means the process itself failed
    // - but it may still have printed a response before dying, so prefer that.
    const stdout = (e as { stdout?: string }).stdout
    if (typeof stdout === 'string' && stdout.trim().length > 0) {
      return parseHelperResponse(stdout)
    }
    return { ok: false, error: (e as Error).message }
  }
}
