// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PresetSetup } from '../PresetSetup'
import { presetById } from '../presetCatalog'

describe('<PresetSetup/> connector recommendation', () => {
  afterEach(() => cleanup())

  it('uses the same connected status as Integrations when Gmail is disabled', async () => {
    ;(window as unknown as { api: unknown }).api = {
      mcpList: vi.fn(async () => [{ name: 'Gmail', enabled: 0, status: 'ok' }])
    }
    const preset = presetById('draft-reply')
    expect(preset).toBeTruthy()
    render(
      <PresetSetup
        preset={preset!}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onOpenConnectors={vi.fn()}
      />
    )

    expect(await screen.findByText('Gmail is connected')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
  })

  it('offers connector setup without blocking the Computer Use path when Gmail has an error', async () => {
    const onOpenConnectors = vi.fn()
    const user = userEvent.setup()
    ;(window as unknown as { api: unknown }).api = {
      mcpList: vi.fn(async () => [{ name: 'Gmail', enabled: 1, status: 'error' }])
    }
    const preset = presetById('draft-reply')
    expect(preset).toBeTruthy()
    render(
      <PresetSetup
        preset={preset!}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onOpenConnectors={onOpenConnectors}
      />
    )

    expect(await screen.findByText('Connect Gmail for direct access')).toBeTruthy()
    expect(
      screen.getByText('You can continue without it. Off Grid AI will use Computer Use instead.')
    ).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(onOpenConnectors).toHaveBeenCalledOnce()
  })
})
