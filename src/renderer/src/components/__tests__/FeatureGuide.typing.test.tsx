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

// The Electron bridge of a computer with no chat model loaded: a starter's answer needs none, and
// anything else comes back as "no model". jsdom has no matchMedia; a window with motion on (the
// default) answers no to reduced motion.
Object.assign(window, {
  api: {
    embedGuideQuestion: () => Promise.resolve(null),
    askGuide: () => Promise.resolve({ error: 'no-model' })
  },
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

it("a feature's Ask more asks about it, and New starts over", async () => {
  render(<FeatureGuide isPro={false} onOpen={() => undefined} />)
  await userEvent.click(screen.getByRole('button', { name: /^Chat/ }))
  await userEvent.click(await screen.findByTestId('guide-topic-ask'))

  expect(await screen.findByText('Tell me more about Chat.')).toBeTruthy()
  await userEvent.click(await screen.findByRole('button', { name: 'New question' }))
  expect(screen.queryByText('Tell me more about Chat.')).toBeNull()
  expect(screen.queryByRole('button', { name: 'New question' })).toBeNull()
})
