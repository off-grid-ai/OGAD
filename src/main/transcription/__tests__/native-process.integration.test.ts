import { describe, expect, it } from 'vitest'
import { runNativeTranscriptionProcess } from '../native-process'

describe('native transcription process cancellation', () => {
  it('terminates an active child process when its request signal aborts', async () => {
    const controller = new AbortController()
    const running = runNativeTranscriptionProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeout: 10_000, signal: controller.signal }
    )

    controller.abort()

    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
  })
})
