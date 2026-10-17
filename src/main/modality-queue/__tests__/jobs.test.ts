/**
 * The two standard heavy-job descriptors. Previously spelled out inline at every
 * call site (chat 4× in ipc.ts); asserted here so their shape — the mutual
 * eviction contract that keeps chat and image off unified memory at once — is
 * defined and checked once.
 */
import { describe, it, expect } from 'vitest'
import { CHAT_JOB, IMAGE_JOB, CAPTURE_JOB, backgroundJob } from '../queue'

describe('standard modality jobs', () => {
  it('CHAT_JOB evicts a resident image server (tier 2)', () => {
    expect(CHAT_JOB).toEqual({ tier: 2, label: 'chat', uses: { id: 'llm' }, evicts: ['image'] })
  })

  it('IMAGE_JOB evicts the resident LLM (tier 2)', () => {
    expect(IMAGE_JOB).toEqual({ tier: 2, label: 'image', uses: { id: 'image' }, evicts: ['llm'] })
  })

  it('they evict each other (mutually exclusive on unified memory)', () => {
    expect(CHAT_JOB.evicts).toContain('image')
    expect(IMAGE_JOB.evicts).toContain('llm')
  })

  it('are frozen so a caller cannot mutate the shared descriptor', () => {
    expect(Object.isFrozen(CHAT_JOB)).toBe(true)
    expect(Object.isFrozen(IMAGE_JOB)).toBe(true)
  })

  it('CAPTURE_JOB is background (tier 3), evicts a resident image server, and yields to foreground work', () => {
    expect(CAPTURE_JOB).toEqual({
      tier: 3,
      label: 'capture',
      uses: { id: 'llm' },
      evicts: ['image'],
      preemptible: true
    })
    expect(Object.isFrozen(CAPTURE_JOB)).toBe(true)
    // Lower priority than chat/image so chat/workspace is always admitted first.
    expect(CAPTURE_JOB.tier).toBeGreaterThan(CHAT_JOB.tier)
  })

  it('backgroundJob(label) shares CAPTURE_JOB’s tier + eviction, only the label varies', () => {
    const j = backgroundJob('screen-replay')
    expect(j.tier).toBe(CAPTURE_JOB.tier)
    expect(j.evicts).toEqual(CAPTURE_JOB.evicts)
    expect(j.preemptible).toBe(true)
    expect(j.label).toBe('screen-replay')
  })
})
