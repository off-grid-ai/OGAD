/**
 * OGAD#240: on a hybrid Intel + NVIDIA laptop, Windows ended the app about 3 s after every launch
 * with 0xFFFF7003, Crashpad's "no handler connected" code. A native fault inside the main process
 * (Chromium screen capture right after DXGI duplication failed) took the app down, left no dump, and
 * ran again on the next launch.
 *
 * A crash is simulated faithfully as what it leaves behind: a step that started and never finished,
 * followed by a new launch on the same profile. Electron's desktopCapturer is the
 * native boundary and are faked; the guard, the vision service and the disk are real.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const native = vi.hoisted(() => ({
  profile: `/tmp/offgrid-native-step-${process.pid}-${Date.now()}`,
  sourceRequests: 0
}))

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQ80sW80tmgFAAFJ4DHTBv/HUAAAAASUVORK5CYII=',
  'base64'
)

vi.mock('electron', () => ({
  app: { getPath: () => native.profile },
  screen: {
    getCursorScreenPoint: () => ({ x: 10, y: 10 }),
    getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 2, height: 2 } })
  },
  desktopCapturer: {
    getSources: async () => {
      native.sourceRequests += 1
      return [
        {
          id: 'screen:1:0',
          display_id: '1',
          thumbnail: {
            isEmpty: () => false,
            getSize: () => ({ width: 2, height: 2 }),
            toPNG: () => PNG
          }
        }
      ]
    }
  }
}))

import { NativeStepGuard, nativeSteps } from '../native-step-guard'
import { vision } from '../vision'

const stepsDir = path.join(native.profile, 'native-steps')

/** A launch that dies inside `step`: the step starts and the process is gone before it returns. */
function launchThatCrashesInside(step: 'screen-capture' | 'active-window'): void {
  void new NativeStepGuard(stepsDir).run(
    step,
    () => new Promise<never>(() => {}),
    () => undefined
  )
}

afterAll(() => fs.rmSync(native.profile, { recursive: true, force: true }))

beforeEach(() => {
  fs.rmSync(stepsDir, { recursive: true, force: true })
  native.sourceRequests = 0
})

describe('a native step that crashed the app', () => {
  it('stays off on the next launch, so the app opens instead of closing again', async () => {
    launchThatCrashesInside('screen-capture')

    const nextLaunch = new NativeStepGuard(stepsDir)
    expect(nextLaunch.recoverInterrupted()).toEqual(['screen-capture'])

    let ran = false
    const answer = await nextLaunch.run(
      'screen-capture',
      async () => {
        ran = true
        return 'frame'
      },
      () => 'skipped'
    )
    expect(ran).toBe(false)
    expect(answer).toBe('skipped')
    // Only the step that crashed is off.
    expect(nextLaunch.blockedSteps()).toEqual(['screen-capture'])
  })

  it('runs again once the user retries it', async () => {
    launchThatCrashesInside('active-window')
    const nextLaunch = new NativeStepGuard(stepsDir)
    nextLaunch.recoverInterrupted()

    nextLaunch.retry('active-window')

    expect(
      await nextLaunch.run(
        'active-window',
        async () => 'window',
        () => null
      )
    ).toBe('window')
    expect(new NativeStepGuard(stepsDir).recoverInterrupted()).toEqual([])
  })

  it('is not blamed when the step finished or threw an ordinary error', async () => {
    const launch = new NativeStepGuard(stepsDir)
    await launch.run(
      'screen-capture',
      async () => 'frame',
      () => null
    )
    await expect(
      launch.run(
        'active-window',
        async () => {
          throw new Error('no window')
        },
        () => null
      )
    ).rejects.toThrow('no window')

    expect(new NativeStepGuard(stepsDir).recoverInterrupted()).toEqual([])
  })

  it('is not blamed when the user quits while it runs', () => {
    const launch = new NativeStepGuard(stepsDir)
    void launch.run(
      'screen-capture',
      () => new Promise<never>(() => {}),
      () => undefined
    )

    launch.settle()

    expect(new NativeStepGuard(stepsDir).recoverInterrupted()).toEqual([])
  })

  it('stays blamed while an overlapping run of the same step is still inside it', async () => {
    const launch = new NativeStepGuard(stepsDir)
    void launch.run(
      'screen-capture',
      () => new Promise<never>(() => {}),
      () => undefined
    )
    await launch.run(
      'screen-capture',
      async () => 'quick frame',
      () => null
    )

    expect(new NativeStepGuard(stepsDir).recoverInterrupted()).toEqual(['screen-capture'])
  })
})

describe('screen capture after it crashed the app', () => {
  it('does not ask the OS for the screen again until retried', async () => {
    launchThatCrashesInside('screen-capture')
    nativeSteps().recoverInterrupted()

    expect(await vision.captureDisplayFrame()).toBeNull()
    expect(native.sourceRequests).toBe(0)

    nativeSteps().retry('screen-capture')
    const frame = await vision.captureDisplayFrame()
    expect(frame?.width).toBe(2)
    expect(native.sourceRequests).toBe(1)
  })
})
