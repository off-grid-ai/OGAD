import { describe, expect, it } from 'vitest'
import { ImageExecutionPlanError, isImageApplicationInFlight } from '@offgrid/models'
import { desktopImageApplication } from '../application-service'

// Product contract: a blank prompt is refused BEFORE any model, runtime, or database is touched.
// The Shared pipeline records the refusal as an error snapshot and returns no result; Desktop's
// `start` must surface that snapshot's cause as the thrown error (the `cause instanceof Error`
// arm of imageApplicationError) and must never invoke `onUpdate` for a request that never ran.
describe('desktopImageApplication.start - refusal before any port is touched', () => {
  it.each(['', '   ', '\n\t'])('throws the Shared prompt-required cause for %j', async (prompt) => {
    const updates: unknown[] = []
    await expect(
      desktopImageApplication.start({ prompt } as never, (update) => updates.push(update))
    ).rejects.toMatchObject({ message: 'A prompt is required.', code: 'prompt-required' })
    expect(updates).toEqual([])
    expect(desktopImageApplication.isRunning()).toBe(false)
  })

  it('leaves an error snapshot carrying the refusal so status() explains the failure', async () => {
    await expect(desktopImageApplication.start({ prompt: '' } as never)).rejects.toBeInstanceOf(
      ImageExecutionPlanError
    )
    const snapshot = desktopImageApplication.status()
    expect(snapshot.phase).toBe('error')
    expect(snapshot.error).toBe('A prompt is required.')
    expect(isImageApplicationInFlight(snapshot.phase)).toBe(false)
  })
})
