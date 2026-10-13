// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskLineups } from '../TaskLineups'
import type { TaskRolesView } from '../../../../shared/task-roles-view'

afterEach(cleanup)

const view = (modelId: string, modelName: string): TaskRolesView => ({
  badges: {},
  tasks: [
    {
      task: 'computer_use',
      taskLabel: 'Computer Use',
      strategyLabel: 'Grounded',
      slots: [
        {
          role: 'grounding_specialist',
          label: 'Grounding specialist',
          does: 'Finds what to click on screen',
          modelId,
          modelName,
          remote: false
        }
      ]
    }
  ]
})

const models = [
  { id: 'ui-tars-1.5-7b', name: 'UI-TARS-1.5-7B', kind: 'computer_use', grounder: true },
  { id: 'ui-mate-9b', name: 'UI-Mate-9B', kind: 'computer_use', grounder: true }
]

describe('<TaskLineups/>', () => {
  it('says when the active grounding specialist is not on this device', () => {
    render(
      <TaskLineups
        view={view('ui-tars-1.5-7b', 'UI-TARS-1.5-7B')}
        models={models}
        installed={['ui-mate-9b']}
      />
    )
    expect(screen.getByText('UI-TARS-1.5-7B (not downloaded)')).toBeTruthy()
  })

  it('names a downloaded active model plainly', () => {
    render(
      <TaskLineups
        view={view('ui-mate-9b', 'UI-Mate-9B')}
        models={models}
        installed={['ui-mate-9b']}
      />
    )
    expect(screen.getByText('UI-Mate-9B')).toBeTruthy()
    expect(screen.queryByText(/not downloaded/)).toBeNull()
  })
})
