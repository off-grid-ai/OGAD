// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { nativeSurfaceIsOccluded } from '@renderer/lib/native-surface-occlusion'
import { ComputerUseStepDetails } from '../ComputerUseStepDetails'

afterEach(cleanup)

describe('<ComputerUseStepDetails/>', () => {
  it('opens a local step screenshot in the shared full-screen viewer', async () => {
    const user = userEvent.setup()
    render(
      <ComputerUseStepDetails
        details={[
          {
            stepId: 'click-search',
            at: 1,
            phase: 'checking',
            decisionSummary: 'Open Search',
            screenshot: {
              path: '/tmp/task-step.png',
              originalWidth: 1200,
              originalHeight: 800,
              inferenceWidth: 1200,
              inferenceHeight: 800
            },
            execution: { status: 'complete', result: 'actuated' }
          }
        ]}
      />
    )

    await user.click(screen.getByRole('button', { name: /Computer Use step 1/ }))
    await user.click(
      screen.getByRole('button', {
        name: 'Open full-screen screenshot for Computer Use step 1'
      })
    )

    expect(screen.getByRole('dialog', { name: 'Task screenshot preview' })).toBeTruthy()
    expect(screen.getAllByAltText('Computer Use step 1')).toHaveLength(2)
    expect(nativeSurfaceIsOccluded()).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(nativeSurfaceIsOccluded()).toBe(false))
  })

  it('keeps a remote screenshot device-local while the synced trace stays useful', async () => {
    const user = userEvent.setup()
    render(
      <ComputerUseStepDetails
        details={[
          {
            stepId: 'click-settings',
            at: 1,
            phase: 'checking',
            decisionSummary: 'Open Settings',
            modelOutput: '<action>click Settings</action>',
            mappedAction: '{"type":"click","point":{"x":520,"y":240}}',
            screenshot: {
              availability: 'unavailable',
              executionDeviceId: 'studio-mac',
              executionDeviceName: 'Studio Mac',
              originalWidth: 3024,
              originalHeight: 1964,
              inferenceWidth: 1512,
              inferenceHeight: 982
            },
            execution: { status: 'complete', durationMs: 42, result: 'actuated' }
          }
        ]}
      />
    )

    await user.click(screen.getByRole('button', { name: /Computer Use step 1/ }))

    expect(screen.getByText('Screenshot stays on Studio Mac.')).toBeTruthy()
    // Once, not twice: the second copy was the persisted prompt echo (modelInput), which is no
    // longer stored - it was 73% of the task payload on every list poll.
    expect(screen.getAllByText('Open Settings', { selector: 'pre' })).toHaveLength(1)
    expect(screen.getByText('<action>click Settings</action>')).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()
  })
})
