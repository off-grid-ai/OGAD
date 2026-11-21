import { Mutex } from 'async-mutex'
import { describe, expect, it } from 'vitest'
import { runExclusiveAbortable } from '../abortable-exclusive'

describe('waiting for the model lock', () => {
  it('stops waiting when the caller aborts, and the lock still frees afterwards', async () => {
    const mutex = new Mutex()
    let finishHolder!: () => void
    const holder = mutex.runExclusive(() => new Promise<void>((resolve) => (finishHolder = resolve)))
    const controller = new AbortController()
    let ran = false
    const waiting = runExclusiveAbortable(
      mutex,
      async () => {
        ran = true
      },
      controller.signal
    )
    controller.abort(new Error('stopped'))
    await expect(waiting).rejects.toThrow('stopped')
    finishHolder()
    await holder
    expect(ran).toBe(false)
    expect(await mutex.runExclusive(async () => 'free')).toBe('free')
  })

  it('runs once the lock is free', async () => {
    const mutex = new Mutex()
    expect(await runExclusiveAbortable(mutex, async () => 7, new AbortController().signal)).toBe(7)
  })
})
