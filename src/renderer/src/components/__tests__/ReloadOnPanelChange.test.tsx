// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { ReloadOnPanelChange } from '../ReloadOnPanelChange'

type Listener = (...args: unknown[]) => void
const listeners = new Map<string, Set<Listener>>()
const emit = (channel: string, payload: unknown): void =>
  listeners.get(channel)?.forEach((listener) => listener(payload))

;(window as unknown as { api: Record<string, unknown> }).api = {
  ...((window as unknown as { api?: Record<string, unknown> }).api ?? {}),
  proOn: (channel: string, listener: Listener) => {
    const set = listeners.get(channel) ?? new Set<Listener>()
    set.add(listener)
    listeners.set(channel, set)
    return () => set.delete(listener)
  }
}

let loads = 0
function Section(): React.JSX.Element {
  const [loaded] = useState(() => ++loads)
  return <p>load {loaded}</p>
}

afterEach(cleanup)

describe('a Settings section changed from the browser panel', () => {
  it('loads again for its own section only', () => {
    render(
      <ReloadOnPanelChange section="voice">
        <Section />
      </ReloadOnPanelChange>
    )
    expect(screen.getByText('load 1')).toBeTruthy()
    act(() => emit('settings:changed-elsewhere', { section: 'image' }))
    expect(screen.getByText('load 1')).toBeTruthy()
    act(() => emit('settings:changed-elsewhere', { section: 'voice' }))
    expect(screen.getByText('load 2')).toBeTruthy()
  })
})
