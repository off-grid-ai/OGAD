// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PresetSetup } from '../PresetSetup'
import { presetById } from '../presetCatalog'

describe('<PresetSetup/> connector recommendation', () => {
  afterEach(() => cleanup())

  it('offers connector setup without blocking the Computer Use path', async () => {
    const onOpenConnectors = vi.fn()
    const user = userEvent.setup()
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
