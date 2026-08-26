// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ComputerUseStepDetails } from '../ComputerUseStepDetails'

afterEach(cleanup)

describe('<ComputerUseStepDetails/>', () => {
  it('keeps a remote screenshot device-local while the synced trace stays useful', async () => {
    const user = userEvent.setup()
    render(
      <ComputerUseStepDetails
        details={[
          {
            stepId: 'click-settings',
            at: 1,
            phase: 'checking',
            modelInput: 'Open Settings',
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
    expect(screen.getAllByText('Open Settings', { selector: 'pre' })).toHaveLength(2)
    expect(screen.getByText('<action>click Settings</action>')).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()
  })
})
