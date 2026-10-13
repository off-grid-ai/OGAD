import { describe, expect, it } from 'vitest'
import {
  taskStrategyOptions,
  taskModelChoices,
  modelsByTab,
  remoteView
} from '../bridge-task-models'
import { TASK_STRATEGIES, parseSettingsPatch } from '../bridge-settings'
import { strategyTaskRoles } from '../../../shared/computer-use-settings'

describe('sealed settings options', () => {
  it.each(TASK_STRATEGIES)('offers the Desktop roles for %s', (value) => {
    const choices = { decision: [{ id: 'd', label: 'D' }], grounding: [{ id: 'g', label: 'G' }] }
    const reasoners = [{ id: 'r', label: 'R' }]
    const option = taskStrategyOptions(choices, reasoners).find((o) => o.value === value)!
    const roles = strategyTaskRoles(value)
    expect(option).toMatchObject({
      available: true,
      decision: roles.includes('decision') ? choices.decision : [],
      grounding: roles.includes('grounding') ? choices.grounding : [],
      reasoner: value === 'separate_specialist' ? [] : reasoners
    })
  })

  it('explains missing roles and allows a text reasoner', () => {
    const options = taskStrategyOptions({ decision: [], grounding: [] }, [])
    expect(options.every((o) => !o.available && o.reasonIfNot)).toBe(true)
    expect(
      taskStrategyOptions({ decision: [{ id: 'd', label: 'D' }], grounding: [] }, [
        { id: 't', label: 'T' }
      ]).find((o) => o.value === 'decision_plus_reasoning')?.available
    ).toBe(true)
  })

  it('offers installed role models, and marks all active task models', () => {
    const catalog = [
      { id: 'g', kind: 'vision', grounder: true },
      { id: 'd', kind: 'computer_use', tags: ['Decision'] },
      { id: 'missing', kind: 'computer_use' }
    ]
    expect(taskModelChoices({ catalog, installed: ['g', 'd'], servers: [] })).toEqual({
      grounding: [{ id: 'g', label: 'g' }],
      decision: [{ id: 'd', label: 'd' }]
    })
    expect(modelsByTab(catalog, ['g', 'd'], ['g', 'd']).computer_use).toEqual([
      { id: 'g', label: 'g', active: true },
      { id: 'd', label: 'd', active: true }
    ])
    expect(modelsByTab(catalog, ['g', 'd'], []).text).toEqual([
      { id: 'g', label: 'g', active: false }
    ])
  })

  it('reports remote servers without a text model as unavailable', () => {
    expect(
      remoteView([{ id: 'x', name: 'X', endpoint: 'http://test', model: '' }], null, false)
        .servers[0]
    ).toMatchObject({ available: false, reasonIfNot: 'No text model selected.' })
  })

  it('accepts text edits and refuses client supplied derived options', () => {
    expect(
      parseSettingsPatch('text', { reasoningBudget: 32768, options: { thinkingBudgets: [999] } })
    ).toEqual({ reasoningBudget: 32768 })
    expect(parseSettingsPatch('text', { draftModel: '../private.gguf' })).toBeNull()
  })
})
