// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import {
  encodeTaskExecutionPlan,
  encodeTaskPhase
} from '../../../../../../shared/task-execution-plan'
import { TaskRunDetails } from '../TaskRunDetails'
import type { TaskTab } from '../task-types'
;(globalThis as unknown as { window: { api: unknown } }).window.api = {
  getModelCatalog: async () => ({
    models: [
      { id: 'qwen-vision', name: 'Qwen Vision 9B' },
      { id: 'gemma-vision', name: 'Gemma Vision 12B' }
    ]
  }),
  getActiveModel: async () => 'gemma-vision',
  getActiveModelIds: async () => ['gemma-vision'],
  getLlmSettings: async () => ({ effectiveCtxSize: 8192, ctxSize: 8192 }),
  tasks: {
    guideAvailability: async () => ({ available: true })
  }
}

afterEach(cleanup)

describe('TaskRunDetails live activity', () => {
  it('keeps the current milestone, operation, final decision, and evidence above guidance', async () => {
    const task: TaskTab = {
      taskId: 'web-live-1',
      journeyId: 'web-live-1',
      modelId: 'qwen-vision',
      modelName: 'Qwen Vision 9B',
      kind: 'web_use',
      title: 'Find a flight',
      status: 'running',
      steps: [
        encodeTaskExecutionPlan({
          version: 1,
          phases: [
            { id: 'phase-1', title: 'Navigate to Skyscanner' },
            { id: 'phase-2', title: 'Enter the flight details' }
          ]
        }),
        encodeTaskPhase('phase-1')
      ],
      startedAt: 1,
      updatedAt: 2,
      phase: 'thinking',
      currentStep: 2,
      currentAction: 'Reviewing the current milestone',
      currentReasoning: 'The search form is visible, and the origin field is empty.',
      reasoningLive: true,
      stepDetails: [
        {
          stepId: '1',
          at: 1,
          phase: 'checking',
          decisionSummary: 'Skyscanner is open.',
          decisionRationale: 'The flight search page is visible.',
          execution: { status: 'complete', result: 'terminal' }
        }
      ]
    }

    render(
      <TaskRunDetails
        task={task}
        onRetryStarted={() => {}}
        showScreenshots={false}
        showDecisionDetails={true}
      />
    )

    const activity = screen.getByRole('region', { name: 'Live model activity' })
    const guidance = screen.getByRole('form', { name: 'Guide running task' })
    expect(activity.textContent).toContain('Navigate to Skyscanner')
    expect(activity.textContent).toContain('Reviewing the current milestone')
    expect(activity.textContent).toContain('Skyscanner is open.')
    expect(activity.textContent).toContain('The flight search page is visible.')
    expect(screen.getByText('Active model: Qwen Vision 9B')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Web Use thinking…' })).toBeTruthy()
    expect(
      screen.getByText('The search form is visible, and the origin field is empty.')
    ).toBeTruthy()
    expect(activity.textContent).not.toContain('Gemma Vision 12B')
    expect(activity.compareDocumentPosition(guidance) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(4)
    expect(await screen.findByPlaceholderText('Guide this task…')).toBeTruthy()
  })

  it('keeps final Web Use reasoning visible after the run ends', async () => {
    const user = userEvent.setup()
    const task: TaskTab = {
      taskId: 'web-final-reasoning',
      journeyId: 'conversation-a',
      modelId: 'qwen-vision',
      modelName: 'Qwen Vision 9B',
      kind: 'web_use',
      title: 'Find a flight',
      status: 'done',
      steps: ['selected one-way'],
      startedAt: 1,
      finishedAt: 3,
      updatedAt: 3,
      phase: 'complete',
      currentStep: 1,
      currentAction: 'Task complete',
      currentReasoning: 'The one-way option is selected, so this milestone is complete.',
      reasoningLive: false
    }

    render(
      <TaskRunDetails
        task={task}
        onRetryStarted={() => {}}
        showScreenshots={false}
        showDecisionDetails={true}
      />
    )

    expect(screen.getByRole('region', { name: 'Model activity' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Web Use reasoning complete' }))
    expect(
      screen.getByText('The one-way option is selected, so this milestone is complete.')
    ).toBeTruthy()
    expect(screen.queryByRole('form', { name: 'Guide running task' })).toBeNull()
  })

  it('collapses the live detail without losing the active milestone and expands it again', async () => {
    const user = userEvent.setup()
    const task: TaskTab = {
      taskId: 'web-live-collapse',
      journeyId: 'web-live-collapse',
      kind: 'web_use',
      title: 'Find a flight',
      status: 'running',
      steps: [
        encodeTaskExecutionPlan({
          version: 1,
          phases: [
            { id: 'phase-1', title: 'Enter the flight details' },
            { id: 'phase-2', title: 'Review the results' }
          ]
        }),
        encodeTaskPhase('phase-1')
      ],
      startedAt: 1,
      updatedAt: 2,
      phase: 'thinking',
      currentStep: 5,
      currentAction: 'Reviewing the current milestone'
    }

    render(
      <TaskRunDetails
        task={task}
        onRetryStarted={() => {}}
        showScreenshots={false}
        showDecisionDetails={true}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Collapse' }))

    expect(screen.getByText('Milestone: Enter the flight details')).toBeTruthy()
    expect(screen.queryByText('Current operation')).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand' }).getAttribute('aria-expanded')).toBe(
      'false'
    )

    await user.click(screen.getByRole('button', { name: 'Expand' }))

    expect(screen.getByText('Current operation')).toBeTruthy()
    expect(screen.getAllByText('Reviewing the current milestone')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Collapse' }).getAttribute('aria-expanded')).toBe(
      'true'
    )
  })

  it('shows the existing task trace when live phase fields have not been published', () => {
    const task: TaskTab = {
      taskId: 'web-trace-fallback',
      journeyId: 'web-trace-fallback',
      kind: 'web_use',
      title: 'Find a flight',
      status: 'running',
      steps: [
        encodeTaskExecutionPlan({
          version: 1,
          phases: [
            { id: 'phase-1', title: 'Enter the flight details' },
            { id: 'phase-2', title: 'Review the results' }
          ]
        }),
        encodeTaskPhase('phase-1'),
        'clicked [67] Search for country, city or airport',
        'typed "Pune" into [67] Search for country, city or airport',
        'clicked [70] Pune (PNQ) India'
      ],
      startedAt: 1,
      updatedAt: 2
    }

    render(
      <TaskRunDetails
        task={task}
        onRetryStarted={() => {}}
        showScreenshots={false}
        showDecisionDetails={true}
      />
    )

    const activity = screen.getByRole('region', { name: 'Live model activity' })
    expect(activity.textContent).toContain('Step 3')
    expect(activity.textContent).toContain('Performing the selected action')
    expect(activity.textContent).toContain('clicked [70] Pune (PNQ) India')
    expect(activity.textContent).not.toContain('Preparing the first live update')
  })
})
