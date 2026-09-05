import { describe, expect, it } from 'vitest'
import {
  applyQueueConfig,
  backgroundJob,
  CAPTURE_JOB,
  CHAT_JOB,
  IMAGE_JOB,
  ModalityQueue,
  QUEUE_DEFAULTS,
  QUEUE_ENABLED_KEY,
  readQueueConfig,
  TIER1_COEXIST_KEY
} from '../queue'

describe('Desktop modality queue composition', () => {
  it('applies persisted settings to the real Shared operation scheduler', () => {
    const persisted = new Map<string, boolean>([
      [QUEUE_ENABLED_KEY, false],
      [TIER1_COEXIST_KEY, false]
    ])
    const queue = new ModalityQueue()

    applyQueueConfig(
      queue,
      readQueueConfig((key, fallback) => persisted.get(key) ?? fallback)
    )

    expect(queue.isEnabled()).toBe(false)
    expect(queue.getConfig()).toEqual({ enabled: false, tier1CoexistsWithTier2: false })
    expect(QUEUE_DEFAULTS).toEqual({ enabled: true, tier1CoexistsWithTier2: true })
  })

  it('runs nested Desktop model work in one admitted Shared operation', async () => {
    const queue = new ModalityQueue()
    const states: string[][] = []
    const unsubscribe = queue.onChange((state) => {
      states.push(state.running.map(({ label }) => label))
    })

    const result = await queue.run(CHAT_JOB, async () =>
      queue.run(IMAGE_JOB, async () => 'nested-result')
    )
    unsubscribe()

    expect(result).toBe('nested-result')
    expect(states).toContainEqual(['chat'])
    expect(states).not.toContainEqual(['chat', 'image'])
    expect(queue.getState()).toEqual({ running: [], queued: [] })
    expect(CAPTURE_JOB).toEqual({ tier: 3, label: 'capture' })
    expect(backgroundJob('model-index')).toEqual({ tier: 3, label: 'model-index' })
  })
})
