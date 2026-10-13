import { describe, expect, it } from 'vitest'
import { REASONING_BUDGET_OPTIONS, optionsWithinCeiling, reconcileBudgets } from '@offgrid/models'
import {
  budgetChange,
  thinkingBudgetOptions,
  speculativeOptions,
  speculativePatch
} from '../text-settings-rules'
import { activeTextAvailability, modelShowsOnTab, remoteTextVision } from '../model-settings-rules'
import { isDecisionModel, isGroundingSpecialist } from '../task-model-rules'

describe('Desktop settings rules', () => {
  it.each([1024, 4096, 131072])('offers Desktop thinking steps within context %i', (ctxSize) => {
    expect(thinkingBudgetOptions({ ctxSize, maxTokens: 0 })).toEqual([
      0,
      ...optionsWithinCeiling(REASONING_BUDGET_OPTIONS, ctxSize)
    ])
    expect(thinkingBudgetOptions({ ctxSize, maxTokens: 512 })).toEqual([0, 512])
    const patch = budgetChange(
      { ctxSize, maxTokens: 0, reasoningBudget: 32768 },
      { maxTokens: 512 }
    )
    expect(patch.reasoningBudget).toBe(
      reconcileBudgets({ contextWindow: ctxSize, maxOutput: 512, thinkingBudget: 32768 })
        .thinkingBudget
    )
  })

  it.each([[[]], [['draft.gguf']]])(
    'offers only supported speculative modes for drafts %j',
    (drafts) => {
      const s = {
        supportsMtp: false,
        compatibleDraftModels: drafts,
        compatibleDflashModels: ['dflash.gguf']
      }
      expect(
        speculativeOptions(s)
          .filter((o) => !o.disabled)
          .map((o) => o.value)
      ).toEqual(drafts.length ? ['off', 'ngram', 'draft', 'dflash'] : ['off', 'ngram', 'dflash'])
      expect(speculativePatch(s, { speculativeDecoding: 'draft', draftModel: 'wrong' })).toEqual(
        drafts.length
          ? { speculativeDecoding: 'draft', draftModel: 'draft.gguf' }
          : { speculativeDecoding: 'off', draftModel: 'wrong' }
      )
    }
  )

  it('reports capabilities of the active model and planner admission', () => {
    expect(activeTextAvailability({ vision: true }, null, true)).toEqual({
      vision: true,
      agent: true
    })
    expect(activeTextAvailability({ vision: false }, null, true)).toEqual({
      vision: false,
      agent: true
    })
    expect(activeTextAvailability(null, null, true)).toEqual({
      vision: false,
      agent: false,
      reasonIfNot: 'No active text model.'
    })
    expect(activeTextAvailability({ vision: true }, 'Unsupported planner', true)).toEqual({
      vision: true,
      agent: false,
      reasonIfNot: 'Unsupported planner'
    })
    expect(activeTextAvailability({ vision: true }, null, false).agent).toBe(false)
  })

  it('shares Desktop tab membership and role filters', () => {
    expect(modelShowsOnTab({ id: 'vision', kind: 'vision' }, 'text')).toBe(true)
    expect(modelShowsOnTab({ id: 'vision+MTP', kind: 'vision' }, 'text')).toBe(false)
    expect(
      modelShowsOnTab({ id: 'grounder', kind: 'vision', grounder: true }, 'computer_use')
    ).toBe(true)
    const decision = { id: 'd', name: 'D', kind: 'computer_use', tags: ['Decision'] }
    expect(isDecisionModel(decision)).toBe(true)
    expect(isGroundingSpecialist(decision)).toBe(false)
  })
  it('uses saved remote input capabilities without vision guesses', () => {
    expect(remoteTextVision({ inputModalities: ['text', 'image'] })).toBe(true)
    expect(remoteTextVision({ inputModalities: ['text'] })).toBe(false)
    expect(remoteTextVision(undefined)).toBe(false)
  })

  it('does not accept client supplied speculative capability fields', () => {
    expect(
      speculativePatch({ supportsMtp: false }, { speculativeDecoding: 'mtp', supportsMtp: true })
    ).toMatchObject({ speculativeDecoding: 'off' })
  })
})
