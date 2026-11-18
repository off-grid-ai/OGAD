// @vitest-environment jsdom
/** The onboarding picks on this computer: kept, cleaned against the shared lists, defaulted. */
import { beforeEach, expect, it } from 'vitest'
import {
  PICKS_KEY,
  cleanPicks,
  clearPicks,
  loadPicks,
  savePicks,
  toggleGroup,
  togglePart
} from '../picks'

beforeEach(() => localStorage.clear())

it('no saved picks, or unreadable ones, start from Chat', () => {
  expect(loadPicks()).toEqual({ groups: ['chat'], parts: ['chat'] })
  localStorage.setItem(PICKS_KEY, '{not json')
  expect(loadPicks()).toEqual({ groups: ['chat'], parts: ['chat'] })
  localStorage.setItem(PICKS_KEY, JSON.stringify({ groups: 'chat' }))
  expect(loadPicks()).toEqual({ groups: ['chat'], parts: ['chat'] })
})

it('saved picks come back, cleaned of what this app does not offer', () => {
  savePicks({ groups: ['create', 'write'], parts: ['images', 'scribe'] })
  expect(loadPicks()).toEqual({ groups: ['create', 'write'], parts: ['images', 'scribe'] })
  // The phone's shared clipboard is not on the desktop; a part needs its group picked.
  expect(
    cleanPicks({
      groups: ['private', 'nope' as never],
      parts: ['shared-clipboard', 'vault', 'images']
    })
  ).toEqual({ groups: ['private'], parts: ['vault'] })
  clearPicks()
  expect(localStorage.getItem(PICKS_KEY)).toBeNull()
})

it('picking a group picks its first part once; unpicking drops its parts', () => {
  const withWrite = toggleGroup({ groups: ['chat'], parts: ['chat'] }, 'write')
  expect(withWrite.groups).toEqual(['chat', 'write'])
  expect(withWrite.parts).toHaveLength(2)
  const again = toggleGroup({ groups: ['chat'], parts: ['chat', ...withWrite.parts] }, 'write')
  expect(again.parts.filter((p) => p === withWrite.parts[1])).toHaveLength(1)
  expect(toggleGroup(withWrite, 'write')).toEqual({ groups: ['chat'], parts: ['chat'] })
})

it('a part toggles on and off', () => {
  const on = togglePart({ groups: ['chat'], parts: [] }, 'web-search')
  expect(on.parts).toEqual(['web-search'])
  expect(togglePart(on, 'web-search').parts).toEqual([])
})
