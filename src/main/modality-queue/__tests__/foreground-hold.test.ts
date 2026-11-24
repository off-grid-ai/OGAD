import { describe, expect, it } from 'vitest'
import { CAPTURE_JOB, ModalityQueue } from '../queue'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A Web Use task calls the model many times with page reads between the calls. Found live: a
 * capture pass slipped into each pause and the task's plan waited behind it on the model.
 */
describe('a foreground hold (a running task) vs background passes', () => {
  it('stops a running capture pass and keeps it out until the hold is released', async () => {
    const queue = new ModalityQueue({ foregroundGraceMs: 50 })
    const events: string[] = []
    let firstRun = true
    const capture = queue.run(CAPTURE_JOB, async () => {
      const signal = queue.currentSignal()
      if (firstRun) {
        firstRun = false
        events.push('capture started')
        await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        )
      }
      events.push('capture ran')
    })
    await wait(0)

    const release = queue.holdForeground('web task')
    await wait(200)
    expect(events).toEqual(['capture started'])
    expect(queue.getState().queued.map((job) => job.label)).toEqual(['capture'])

    release()
    await capture
    expect(events).toEqual(['capture started', 'capture ran'])
  })

  it('releasing twice is harmless', async () => {
    const queue = new ModalityQueue()
    const release = queue.holdForeground('web task')
    release()
    release()
    await queue.run(CAPTURE_JOB, async () => undefined)
  })
})
