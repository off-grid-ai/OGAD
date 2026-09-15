// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { KeyboardShortcuts } from '../KeyboardShortcuts'
import { SettingsCard, SettingsCardsGroup } from '../SettingsCard'

interface ShortcutSnapshot {
  accelerator: string
  shortcutRegistered: boolean
}

function installDesktopBoundary(snapshot: ShortcutSnapshot): void {
  const api = new Proxy(
    {
      isPro: true,
      platform: 'darwin',
      proInvoke: async (channel: string) => {
        if (channel !== 'voice:dictation:get-settings') {
          throw new Error(`Unexpected Pro request: ${channel}`)
        }
        return snapshot
      },
      proOn: () => () => {}
    },
    {
      get(target, property: string) {
        if (property in target) return target[property as keyof typeof target]
        if (property === 'getAppVersion') return async () => ''
        return async () => undefined
      }
    }
  )
  ;(window as unknown as { api: unknown }).api = api
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

function ShortcutSettingsJourney(): React.JSX.Element {
  return (
    <SettingsCardsGroup>
      <SettingsCard title="Keyboard shortcuts" summary="Every hotkey in one place." delay={0}>
        <KeyboardShortcuts />
      </SettingsCard>
    </SettingsCardsGroup>
  )
}

describe('Settings keyboard shortcut journey', () => {
  it('shows the configured shortcut and confirms macOS registered it', async () => {
    const user = userEvent.setup()
    installDesktopBoundary({
      accelerator: 'Command+Shift+D',
      shortcutRegistered: true
    })

    render(<ShortcutSettingsJourney />)
    await user.click(screen.getByRole('button', { name: /Keyboard shortcuts/i }))

    expect(await screen.findByText('Cmd+Shift+D')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Registered on this Mac')
    expect(screen.queryByText('Option+Space')).toBeNull()
  })

  it('shows the configured shortcut when native registration failed', async () => {
    const user = userEvent.setup()
    installDesktopBoundary({
      accelerator: 'Control+Space',
      shortcutRegistered: false
    })

    render(<ShortcutSettingsJourney />)
    await user.click(screen.getByRole('button', { name: /Keyboard shortcuts/i }))

    expect(await screen.findByText('Ctrl+Space')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Not registered on this Mac')
  })
})
