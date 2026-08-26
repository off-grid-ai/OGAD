// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  encodeTaskExecutionPlan,
  encodeTaskPhase
} from '../../../../../../shared/task-execution-plan'
import { TaskExecutionPlanView } from '../TaskExecutionPlanView'
import type { TaskTab } from '../task-types'

const plan = {
  version: 1 as const,
  phases: [
    { id: 'phase-1', title: 'Open booking.com' },
    { id: 'phase-2', title: 'Set the travel filters' },
    { id: 'phase-3', title: 'Review matching stays' }
  ]
}

afterEach(cleanup)

function task(status: TaskTab['status'] = 'running'): TaskTab {
  return {
    taskId: 'task-1',
    kind: 'web_use',
    title: 'Find a hotel',
    status,
    steps: [
      encodeTaskExecutionPlan(plan),
      encodeTaskPhase('phase-1'),
      'opened https://booking.com',
      encodeTaskPhase('phase-2'),
      'clicked [8] Destination',
      'USER GUIDANCE · Use the city centre',
      'typed "London" into [8] Destination'
    ],
    startedAt: 1,
    updatedAt: 2
  }
}

describe('TaskExecutionPlanView', () => {
  it('groups dynamic actions under completed, current, and upcoming phases', () => {
    render(<TaskExecutionPlanView task={task()} guidanceMessages={['Use the city centre']} />)
    expect(screen.getByText('1 of 3 stages complete')).toBeTruthy()
    expect(screen.getByText('Open booking.com')).toBeTruthy()
    expect(screen.getByText('Set the travel filters')).toBeTruthy()
    expect(screen.getByText('Review matching stays')).toBeTruthy()
    const planView = screen.getByRole('region', { name: 'Task execution plan' })
    expect(within(planView).getByText('clicked [8] Destination')).toBeTruthy()
    expect(within(planView).getByText('Use the city centre')).toBeTruthy()
    expect(within(planView).getByText('upcoming')).toBeTruthy()
  })

  it('shows a saved screenshot under the action that used it', () => {
    const withEvidence = task()
    withEvidence.stepDetails = [
      {
        stepId: 'step-1',
        at: 1,
        phase: 'checking',
        decisionSummary: '',
        mappedAction: JSON.stringify({ type: 'click', point: { x: 8, y: 9 } }),
        screenshot: {
          path: '/tmp/task-shot.png',
          originalWidth: 1200,
          originalHeight: 800,
          inferenceWidth: 1200,
          inferenceHeight: 800
        },
        execution: { status: 'complete', durationMs: 1, result: 'actuated' }
      }
    ]
    withEvidence.steps = [
      encodeTaskExecutionPlan(plan),
      encodeTaskPhase('phase-1'),
      'click at (8, 9)'
    ]
    render(<TaskExecutionPlanView task={withEvidence} />)
    const image = screen.getByAltText('Screen before click at (8, 9)')
    expect(image.getAttribute('src')).toContain('task-shot.png')
  })

  it('shows the concise model rationale separately from the selected action', () => {
    const withEvidence = task()
    withEvidence.stepDetails = [
      {
        stepId: 'step-1',
        at: 1,
        phase: 'checking',
        decisionSummary: 'Open the destination field',
        decisionRationale: 'The destination must be set before the dates can be selected.',
        mappedAction: JSON.stringify({ type: 'click', point: { x: 8, y: 9 } }),
        screenshot: {
          path: '/tmp/task-shot.png',
          originalWidth: 1200,
          originalHeight: 800,
          inferenceWidth: 1200,
          inferenceHeight: 800
        },
        execution: { status: 'complete', result: 'actuated' }
      }
    ]
    withEvidence.steps = [
      encodeTaskExecutionPlan(plan),
      encodeTaskPhase('phase-1'),
      'click at (8, 9)'
    ]

    render(<TaskExecutionPlanView task={withEvidence} />)

    expect(screen.getByText('Open the destination field')).toBeTruthy()
    expect(
      screen.getByText('The destination must be set before the dates can be selected.')
    ).toBeTruthy()
  })

  it('shows the judge summary and visible evidence on a completed milestone', () => {
    const withEvidence = task()
    withEvidence.stepDetails = [
      {
        stepId: 'judge-1',
        at: 1,
        phase: 'checking',
        decisionSummary: 'Skyscanner is open.',
        decisionRationale: 'The Skyscanner flight search page is visible.',
        screenshot: {
          path: '/tmp/skyscanner-judge.png',
          originalWidth: 1200,
          originalHeight: 800,
          inferenceWidth: 1200,
          inferenceHeight: 800
        },
        execution: { status: 'complete', result: 'terminal' }
      }
    ]
    withEvidence.steps = [
      encodeTaskExecutionPlan(plan),
      encodeTaskPhase('phase-1'),
      'milestone complete: Open booking.com',
      encodeTaskPhase('phase-2')
    ]

    render(<TaskExecutionPlanView task={withEvidence} />)

    expect(screen.getByText('Skyscanner is open.')).toBeTruthy()
    expect(screen.getByText('The Skyscanner flight search page is visible.')).toBeTruthy()
    expect(screen.getByAltText('Screen before milestone complete: Open booking.com')).toBeTruthy()
  })

  it('keeps evidence inline when live CSS coordinates differ by a few pixels', () => {
    const withEvidence = task()
    withEvidence.stepDetails = [
      {
        stepId: 'step-1',
        at: 1,
        phase: 'checking',
        mappedAction: JSON.stringify([{ type: 'click', point: { x: 235, y: 36 } }]),
        screenshot: {
          path: '/tmp/live-shot.png',
          originalWidth: 1200,
          originalHeight: 800,
          inferenceWidth: 1200,
          inferenceHeight: 800
        },
        execution: { status: 'complete', result: 'actuated' }
      }
    ]
    withEvidence.steps = [
      encodeTaskExecutionPlan(plan),
      encodeTaskPhase('phase-1'),
      'click at (239, 37)'
    ]
    render(<TaskExecutionPlanView task={withEvidence} />)
    expect(screen.getByAltText('Screen before click at (239, 37)')).toBeTruthy()
    fireEvent.click(screen.getByText('click at (239, 37)'))
    expect(screen.getByTestId('task-click-marker')).toBeTruthy()
  })

  it('uses separate horizontal and vertical scales for the click marker', () => {
    const withEvidence = task()
    withEvidence.stepDetails = [
      {
        stepId: 'step-1',
        at: 1,
        phase: 'checking',
        mappedAction: JSON.stringify([{ type: 'click', point: { x: 400, y: 600 } }]),
        actionCoordinateSpace: 'viewport',
        screenshot: {
          path: '/tmp/retina-shot.png',
          originalWidth: 2000,
          originalHeight: 1800,
          inferenceWidth: 1024,
          inferenceHeight: 768,
          viewportWidth: 1000,
          viewportHeight: 750
        },
        execution: { status: 'complete', result: 'actuated' }
      }
    ]
    withEvidence.steps = [
      encodeTaskExecutionPlan(plan),
      encodeTaskPhase('phase-1'),
      'click at (400, 600)'
    ]

    render(<TaskExecutionPlanView task={withEvidence} />)
    fireEvent.click(screen.getByRole('button', { name: /click at \(400, 600\)/ }))
    const marker = screen.getByTestId('task-click-marker')
    expect(marker.style.left).toBe('40%')
    expect(marker.style.top).toBe('80%')
  })

  it('projects inference points with inference dimensions', () => {
    const withEvidence = task()
    withEvidence.stepDetails = [
      {
        stepId: 'step-1',
        at: 1,
        phase: 'thinking',
        mappedAction: JSON.stringify({ type: 'click', point: { x: 119, y: 799 } }),
        actionCoordinateSpace: 'inference',
        screenshot: {
          path: '/tmp/ui-mate-shot.png',
          originalWidth: 1064,
          originalHeight: 1316,
          inferenceWidth: 832,
          inferenceHeight: 1024,
          viewportWidth: 532,
          viewportHeight: 658
        },
        execution: { status: 'complete', result: 'reviewed' }
      }
    ]
    withEvidence.steps = [
      encodeTaskExecutionPlan(plan),
      encodeTaskPhase('phase-1'),
      'click at (119, 799)'
    ]

    render(<TaskExecutionPlanView task={withEvidence} />)
    fireEvent.click(screen.getByRole('button', { name: /click at \(119, 799\)/ }))
    const marker = screen.getByTestId('task-click-marker')
    expect(Number.parseFloat(marker.style.left)).toBeCloseTo((119 * 100) / 832, 5)
    expect(Number.parseFloat(marker.style.top)).toBeCloseTo((799 * 100) / 1024, 5)
  })

  it('shows the screenshot that caused a rejected action', () => {
    const withEvidence = task()
    const reason = 'The browser size changed after the screenshot.'
    withEvidence.stepDetails = [
      {
        stepId: 'step-1',
        at: 1,
        phase: 'checking',
        mappedAction: JSON.stringify([{ type: 'click', point: { x: 10, y: 20 } }]),
        screenshot: {
          path: '/tmp/rejected-shot.png',
          originalWidth: 1200,
          originalHeight: 800,
          inferenceWidth: 1200,
          inferenceHeight: 800
        },
        execution: { status: 'complete', result: 'blocked', error: reason }
      }
    ]
    withEvidence.steps = [
      encodeTaskExecutionPlan(plan),
      encodeTaskPhase('phase-1'),
      `rejected action: ${reason}`
    ]
    render(<TaskExecutionPlanView task={withEvidence} />)
    expect(screen.getByAltText(`Screen before rejected action: ${reason}`)).toBeTruthy()
  })

  it('never moves milestone progress backwards when the model revisits an earlier phase', () => {
    const revisiting = task()
    revisiting.steps.push(
      encodeTaskPhase('phase-1'),
      'rechecked the booking page after entering filters'
    )
    render(<TaskExecutionPlanView task={revisiting} />)
    expect(screen.getByText('1 of 3 stages complete')).toBeTruthy()
    expect(screen.getByText('Set the travel filters').closest('summary')?.textContent).toContain(
      'active'
    )
  })

  it('does not mark unreached milestones complete when a task ends early', () => {
    const endedEarly = task('done')
    endedEarly.steps = [
      encodeTaskExecutionPlan(plan),
      encodeTaskPhase('phase-1'),
      'opened https://booking.com'
    ]

    render(<TaskExecutionPlanView task={endedEarly} />)

    expect(screen.getByText('1 of 3 stages complete')).toBeTruthy()
    expect(screen.getAllByText('upcoming')).toHaveLength(2)
  })
})
