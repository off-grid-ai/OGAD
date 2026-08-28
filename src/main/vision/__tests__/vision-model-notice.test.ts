/**
 * Computer Use accepts every compatible vision model without recommending a
 * different model. Missing and non-vision models retain their blocking notice.
 */
import { describe, expect, it } from 'vitest'
import {
  visionModelNotice,
  grounderNudgeForQueuedTask,
  isGrounderActive
} from '../vision-model-notice'

describe('visionModelNotice', () => {
  it('says nothing when a grounder is loaded', () => {
    expect(visionModelNotice({ id: 'mradermacher/UI-TARS-1.5-7B-GGUF', vision: true })).toBeNull()
    // Off-catalog grounder by name heuristic.
    expect(visionModelNotice({ id: 'someone/Holo1.5-7B-GGUF', vision: true })).toBeNull()
  })

  it('says nothing when a general vision model is loaded', () => {
    expect(
      visionModelNotice({ id: 'unsloth/Qwen3-VL-8B-Instruct-GGUF', vision: true })
    ).toBeNull()
  })

  it('says computer use will not work when the model cannot see', () => {
    const notice = visionModelNotice({ id: 'meta/Llama-3-8B', vision: false })
    expect(notice).toMatch(/cannot read the screen/i)
    expect(notice).toMatch(/will not work/i)
  })

  it('handles no model loaded', () => {
    expect(visionModelNotice(null)).toMatch(/No model is loaded/i)
  })

  it('every blocking notice names the fix', () => {
    for (const model of [null, { id: 'x', vision: false }]) {
      expect(visionModelNotice(model)).toMatch(/Models screen/)
    }
  })
})

describe('grounderNudgeForQueuedTask', () => {
  const general = { id: 'unsloth/Qwen3-VL-8B-Instruct-GGUF', vision: true }

  it('says NOTHING when the accessibility rail will drive the task - no grounder needed', () => {
    // The headline case: a general model driving an AX-rich app (Slack). Nudging
    // for a grounder here would contradict the feature.
    expect(grounderNudgeForQueuedTask(general, true)).toBeNull()
    expect(grounderNudgeForQueuedTask(null, true)).toBeNull()
  })

  it('says nothing when a general vision model will drive the task', () => {
    expect(grounderNudgeForQueuedTask(general, false)).toBeNull()
  })

  it('says nothing when a grounder is loaded, even falling to vision', () => {
    expect(
      grounderNudgeForQueuedTask({ id: 'mradermacher/UI-TARS-1.5-7B-GGUF', vision: true }, false)
    ).toBeNull()
  })
})

describe('isGrounderActive', () => {
  it('is true only for a vision model that is a grounder', () => {
    expect(isGrounderActive({ id: 'mradermacher/UI-TARS-1.5-7B-GGUF', vision: true })).toBe(true)
  })

  it('is false for a general vision model, a non-vision model, or none', () => {
    expect(isGrounderActive({ id: 'unsloth/Qwen3-VL-8B-Instruct-GGUF', vision: true })).toBe(false)
    // A grounder id with no vision projector cannot ground - not usable.
    expect(isGrounderActive({ id: 'mradermacher/UI-TARS-1.5-7B-GGUF', vision: false })).toBe(false)
    expect(isGrounderActive(null)).toBe(false)
  })
})
