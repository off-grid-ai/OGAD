// @vitest-environment jsdom
/**
 * The guide's answers type out when they arrive, then stand whole with their pictures. A starter
 * question is answered from the guide itself, with no model, so nothing else is needed here.
 */
import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FeatureGuide } from '../FeatureGuide'

afterEach(cleanup)

// The Electron bridge with no services behind it: a starter's answer needs none. jsdom has no
// matchMedia; a window with motion on (the default) answers no to reduced motion.
Object.assign(window, {
  api: {},
  matchMedia: (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined
  })
})

it('an answer types out, then shows whole with the card it names', async () => {
  render(<FeatureGuide isPro={false} onOpen={() => undefined} />)
  await userEvent.click(screen.getByRole('button', { name: 'What works on my phone?' }))

  // Its card comes after its words, so right after the question it is not there yet.
  expect(screen.queryByText('Free on the App Store and Google Play')).toBeNull()
  expect(
    await screen.findByText('Free on the App Store and Google Play', {}, { timeout: 3000 })
  ).toBeTruthy()
})
