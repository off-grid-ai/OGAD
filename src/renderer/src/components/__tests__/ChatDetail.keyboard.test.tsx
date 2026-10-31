// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatDetail } from '../ChatDetail'

const originalApi = window.api

beforeEach(() => {
  // The Electron preload is the external boundary. Render the real panel and controls
  // against the same session-record contract returned by its two read-only IPC calls.
  const sessionApi: Pick<Window['api'], 'getChatSessions' | 'getEntitiesForSession'> = {
    getChatSessions: async () => [
      {
        session_id: 'keyboard-session',
        last_activity: '2026-10-14 10:00:00',
        memory_count: 0,
        entity_count: 0,
        summary: 'Read the [source](https://example.test/source).'
      }
    ],
    getEntitiesForSession: async () => []
  }
  window.api = { ...originalApi, ...sessionApi }
})

afterEach(() => {
  cleanup()
  window.api = originalApi
})

describe('Chat Detail keyboard access', () => {
  for (const section of ['summary', 'entities']) {
    for (const key of ['{Enter}', ' ']) {
      it(`opens ${section} with ${key} and closes with Escape`, async () => {
        const user = userEvent.setup()
        render(<ChatDetail sessionId="keyboard-session" onBack={() => {}} />)
        const panel = await screen.findByRole('button', { name: `Expand ${section}` })
        await screen.findByRole('link', { name: 'source' })
        for (let step = 0; step < 12 && document.activeElement !== panel; step++) await user.tab()
        expect(document.activeElement).toBe(panel)
        await user.keyboard('{ArrowRight}')
        expect(
          screen.queryByText(`${section.charAt(0).toUpperCase()}${section.slice(1)} View`)
        ).toBeNull()
        await user.keyboard(key)
        expect(
          await screen.findByText(`${section.charAt(0).toUpperCase()}${section.slice(1)} View`)
        ).toBeTruthy()
        await user.keyboard('{Escape}')
        await waitFor(() =>
          expect(
            screen.queryByText(`${section.charAt(0).toUpperCase()}${section.slice(1)} View`)
          ).toBeNull()
        )
        expect(await screen.findByRole('button', { name: `Expand ${section}` })).toBeTruthy()
      })
    }
  }

  it('does not expand the summary when Space is pressed on a source link', async () => {
    const user = userEvent.setup()
    render(<ChatDetail sessionId="keyboard-session" onBack={() => {}} />)
    const link = await screen.findByRole('link', { name: 'source' })
    for (let step = 0; step < 12 && document.activeElement !== link; step++) await user.tab()
    expect(document.activeElement).toBe(link)
    await user.keyboard(' ')
    expect(screen.queryByText('Summary View')).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand summary' })).toBeTruthy()
  })
})
