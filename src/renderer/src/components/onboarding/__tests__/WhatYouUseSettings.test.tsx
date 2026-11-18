// @vitest-environment jsdom
/** Settings → What you use: every feature on show, a tap saves, and the menu hears about it. */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WhatYouUseSettings } from '../WhatYouUseSettings'
import { PICKS_CHANGED_EVENT, PICKS_KEY, savePicks } from '../picks'

beforeEach(() => localStorage.clear())
afterEach(cleanup)

const saved = (): { groups: string[]; parts: string[] } =>
  JSON.parse(localStorage.getItem(PICKS_KEY) ?? 'null')

it('shows every group, ticks what was picked, and a tap saves and tells the menu', async () => {
  savePicks({ groups: ['chat'], parts: ['chat'] })
  const changed = vi.fn()
  window.addEventListener(PICKS_CHANGED_EVENT, changed)
  const user = userEvent.setup()
  render(<WhatYouUseSettings />)
  expect(screen.getByTestId('what-you-use-chat').getAttribute('aria-checked')).toBe('true')
  expect(screen.getByTestId('what-you-use-meetings').getAttribute('aria-checked')).toBe('false')

  await user.click(screen.getByTestId('what-you-use-meetings'))
  expect(screen.getByTestId('what-you-use-meetings').getAttribute('aria-checked')).toBe('true')
  expect(saved()).toEqual({ groups: ['chat', 'meetings'], parts: ['chat', 'meetings'] })
  expect(changed).toHaveBeenCalled()

  // The last feature of a group out takes the group with it.
  await user.click(screen.getByTestId('what-you-use-chat'))
  expect(saved()).toEqual({ groups: ['meetings'], parts: ['meetings'] })
  window.removeEventListener(PICKS_CHANGED_EVENT, changed)
})
