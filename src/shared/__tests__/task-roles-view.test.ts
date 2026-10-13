import { describe, expect, it } from 'vitest'
import { taskRolesView } from '../task-roles-view'

const model = (
  role: 'reasoner' | 'decision' | 'grounding_specialist',
  modelId: string,
  remote = false
): {
  role: 'reasoner' | 'decision' | 'grounding_specialist'
  modelId: string
  modelName: string
  remote: boolean
} => ({
  role,
  modelId,
  modelName: modelId,
  remote
})

describe('taskRolesView', () => {
  it('lines up the models each task runs together, and names what each one does', () => {
    const view = taskRolesView({
      computerUse: {
        strategy: 'decision_plus_specialist',
        strategyLabel: 'Decision + Reasoning + Specialist',
        models: [
          model('decision', 'kev-4b'),
          model('reasoner', 'gemini', true),
          model('grounding_specialist', 'ui-tars', true)
        ]
      },
      webUse: {
        strategy: 'decision_plus_reasoning',
        strategyLabel: 'Decision + Reasoning',
        models: [model('decision', 'jev', true), model('reasoner', 'gemini', true)]
      }
    })
    // The reasoner is the Text model: not a task model, so not in a lineup or a badge.
    expect(view.tasks.map((t) => [t.taskLabel, t.slots.map((s) => s.label)])).toEqual([
      ['Web Use', ['Decision model']],
      ['Computer Use', ['Decision model', 'Grounding specialist']]
    ])
    expect(view.badges).toEqual({
      jev: 'Decision model · Web Use',
      'kev-4b': 'Decision model · Computer Use',
      'ui-tars': 'Grounding specialist · Computer Use'
    })
  })
})
