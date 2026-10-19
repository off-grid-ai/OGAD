// @vitest-environment jsdom

// Integration: "MTP downloads: On" changes what a NEW download fetches. It must not replace an
// installed model's card with the MTP variant. Reported from a Windows machine (2026-10-17): with
// MTP downloads on, the active UI-Mate-9B grounding specialist showed as "UI-Mate-9B MTP", coming
// soon, with no Use or Delete, so it could not be changed. Real ModelsScreen; only window.api, the
// IPC line out of the renderer, is faked, answering with main's catalog shape (main adds the UI-Mate
// "+MTP" entry as coming soon).
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const UI_MATE = {
  id: 'bartowski/tencent_UI-Mate-9B-GGUF',
  name: 'UI-Mate-9B',
  kind: 'computer_use',
  org: 'Tencent',
  grounder: true,
  availability: 'ready',
  files: [{ name: 'tencent_UI-Mate-9B-Q4_K_M.gguf', role: 'primary', sizeBytes: 5.6e9, url: 'x' }]
}
const UI_MATE_MTP = {
  ...UI_MATE,
  id: `${UI_MATE.id}+MTP`,
  name: 'UI-Mate-9B MTP',
  availability: 'coming_soon',
  availabilityNote: 'The separate UI-Mate MTP download is not yet verified.'
}

afterEach(() => cleanup())

function bridge(installed: string[]): void {
  ;(window as unknown as { api: unknown }).api = {
    systemHealth: async () => ({ ramGb: 32 }),
    getModelCatalog: async () => ({ kinds: ['computer_use'], models: [UI_MATE, UI_MATE_MTP] }),
    getInstalledModels: async () => installed,
    getActiveModelIds: async () => installed,
    getModelVisionStatus: async () => ({}),
    estimateModelFit: async () => ({ level: 'ok' }),
    onModelProgress: () => () => {},
    searchModels: async () => [],
    getModelFiles: async () => []
  }
}

describe('<ModelsScreen/> MTP downloads and an installed model', () => {
  it('keeps the installed UI-Mate card, usable and deletable, when MTP downloads are on', async () => {
    bridge([UI_MATE.id])
    const { ModelsScreen } = await import('../ModelsScreen')
    const user = userEvent.setup()
    render(<ModelsScreen />)

    const onDevice = await screen.findByRole('list', { name: /on this device/i })
    expect(within(onDevice).getByText('UI-Mate-9B')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /MTP downloads: Off/ }))
    await screen.findByRole('button', { name: /MTP downloads: On/ })

    const stillOnDevice = screen.getByRole('list', { name: /on this device/i })
    expect(within(stillOnDevice).getByText('UI-Mate-9B')).toBeTruthy()
    expect(within(stillOnDevice).queryByText('UI-Mate-9B MTP')).toBeNull()
    expect(within(stillOnDevice).queryByText(/Available after support is fully tested/)).toBeNull()
    // Active, so Delete waits for a switch (the Tasks dropdown), and says so.
    const remove = within(stillOnDevice).getByRole('button', { name: 'Delete' })
    expect((remove as HTMLButtonElement).disabled).toBe(true)
    expect(remove.getAttribute('title')).toBe('Switch to another model before deleting')
  })
})
