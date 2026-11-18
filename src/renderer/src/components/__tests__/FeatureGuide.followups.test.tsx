// @vitest-environment jsdom
/**
 * A flow's answer offers what usually comes next as chips, starting with the branch for each of its
 * conditions; a follow-up question about a condition is read against the flow just shown. No model.
 */
import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FeatureGuide } from '../FeatureGuide'

afterEach(cleanup)

// A computer with no chat model and no search model: only the guide's own flows answer.
Object.assign(window, {
  api: {
    embedGuideQuestion: () => Promise.resolve(null),
    askGuide: () => Promise.resolve({ error: 'no-model' })
  },
  matchMedia: (query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined
  })
})

const askBox = (): HTMLElement => screen.getByRole('textbox', { name: 'Your question' })

it("pairing's answer offers the other-network branch, and tapping it shows that flow", async () => {
  render(<FeatureGuide isPro={false} onOpen={() => undefined} />)
  await userEvent.type(askBox(), 'Pair another device{Enter}')
  // Pairing a device and turning on Pro by pairing read alike: the person picks.
  await userEvent.click(
    await screen.findByTestId('guide-pick-desk-devices-pair', {}, { timeout: 3000 })
  )
  const chip = await screen.findByTestId(
    'guide-next-cross-connect-device-by-address',
    {},
    { timeout: 3000 }
  )
  expect(chip.textContent).toMatch(/^Not both devices on the same network\? /)
  await userEvent.click(chip)
  expect(
    await screen.findByText(/Connect to a paired device by IP address:/, {}, { timeout: 3000 })
  ).toBeTruthy()
})

it('a follow-up about the condition is answered from the flow just shown, with no model', async () => {
  render(<FeatureGuide isPro={false} onOpen={() => undefined} />)
  await userEvent.type(askBox(), 'Pair another device{Enter}')
  // Pairing a device and turning on Pro by pairing read alike: the person picks.
  await userEvent.click(
    await screen.findByTestId('guide-pick-desk-devices-pair', {}, { timeout: 3000 })
  )
  await screen.findByTestId('guide-next-cross-connect-device-by-address', {}, { timeout: 3000 })
  await userEvent.type(askBox(), "what if they're not on the same network?{Enter}")
  expect(
    await screen.findByText(/Connect to a paired device by IP address:/, {}, { timeout: 3000 })
  ).toBeTruthy()
})
