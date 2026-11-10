/**
 * OGAD#240: Windows ended the app with 0xFFFF7003 (Crashpad: no handler connected) and wrote no
 * dump, so nobody could see which native call crashed. Electron's crashReporter is the native
 * boundary, faked to its contract; the step guard and the disk are real.
 */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NativeStepGuard } from '../native-step-guard'
import { startLocalCrashEvidence } from '../bootstrap/crash-evidence'

const stepsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-crash-evidence-'))
afterAll(() => fs.rmSync(stepsDir, { recursive: true, force: true }))

describe('crash evidence at launch', () => {
  it('connects a crash handler that keeps dumps on this machine and names the crashed step', () => {
    // Electron's contract: after start(), getUploadToServer() reports the upload choice.
    let started: { uploadToServer?: boolean } | null = null
    const reporter = {
      start: (options: { uploadToServer?: boolean }) => {
        started = options
      },
      getUploadToServer: () => started?.uploadToServer ?? true
    }
    const lines: string[] = []
    // The last launch died inside screen capture.
    void new NativeStepGuard(stepsDir).run(
      'screen-capture',
      () => new Promise<never>(() => {}),
      () => undefined
    )
    const thisLaunch = new NativeStepGuard(stepsDir)

    startLocalCrashEvidence(reporter, thisLaunch, '/dumps', (line) => lines.push(line))

    expect(started).not.toBeNull()
    expect(reporter.getUploadToServer()).toBe(false)
    expect(thisLaunch.isBlocked('screen-capture')).toBe(true)
    expect(lines.join('\n')).toContain('screen-capture')
    expect(lines.join('\n')).toContain('/dumps')
  })
})
