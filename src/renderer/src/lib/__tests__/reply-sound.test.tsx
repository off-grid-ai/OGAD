// @vitest-environment jsdom
// The reply sound: one saved setting behind every toggle that shows it.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { REPLY_SOUND_SETTING, useReplySound } from '../reply-sound'

afterEach(() => cleanup())

function installSettings(initial: Record<string, unknown> = {}): Map<string, unknown> {
  const saved = new Map(Object.entries(initial))
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    getSettings: async () => Object.fromEntries(saved),
    saveSetting: async (key: string, value: unknown) => void saved.set(key, value)
  }
  return saved
}

describe('useReplySound', () => {
  it('is on until turned off', async () => {
    installSettings()
    const { result } = renderHook(() => useReplySound())
    await waitFor(() => expect(result.current[0]).toBe(true))
  })

  it("keeps Chat's and God's toggles on one saved setting, each seeing the other's change", async () => {
    const saved = installSettings()
    const chat = renderHook(() => useReplySound())
    const god = renderHook(() => useReplySound())
    act(() => god.result.current[1](false))
    await waitFor(() => expect(saved.get(REPLY_SOUND_SETTING)).toBe(false))
    await waitFor(() => expect(chat.result.current[0]).toBe(false))
  })
})
