// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { SettingsPanel } from '../SettingsPanel'
import { normalizeBackendPreferences } from '../../../../shared/backend-preferences'
import {
  matchesBestSettings,
  planBestSettings,
  type MachineProfile
} from '../../../../shared/best-settings'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

// The preload bridge is the boundary: behind it, main detects this Mac and saves the plan.
const machine: MachineProfile = {
  platform: 'darwin',
  cpuModel: 'Apple M5',
  performanceCores: 4,
  totalRamGb: 32,
  gpu: 'Metal'
}
const plan = planBestSettings(machine, { weightsGb: 6.4, supportsMtp: true, modelMaxCtx: 262_144 })

function installBridge(start: { llm: Record<string, unknown>; backends: object }): void {
  let preferences = normalizeBackendPreferences(start.backends, 'darwin')
  let llmSettings = start.llm
  let residency: Record<string, string> = {}
  let screenshotSize = 'large'
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    platform: 'darwin',
    bestSettingsStatus: async () => ({
      applied: matchesBestSettings(plan, {
        chat: llmSettings,
        backends: preferences,
        residency,
        screenshotSize
      })
    }),
    applyBestSettings: async () => {
      preferences = { ...preferences, ...plan.backends }
      llmSettings = { ...llmSettings, ...plan.chat }
      residency = { ...residency, ...plan.residency }
      screenshotSize = plan.screenshotSize
      return { machine, plan }
    },
    backendPreferencesGet: async () => preferences,
    backendPreferenceSet: async () => preferences,
    runtimeBackends: async () => [],
    getLlmSettings: async () => llmSettings,
    setLlmSettings: async () => undefined,
    getModelCatalog: async () => ({ models: [] }),
    getActiveModel: async () => null,
    getSettings: async () => ({}),
    getTranscriptionInfo: async () => null,
    listTools: async () => [],
    mcpList: async () => []
  }
}

it('offers the fastest settings in one slim row, applies them, then slides the row away', async () => {
  installBridge({
    llm: { speculativeDecoding: 'dflash', supportsMtp: true, kvCacheType: 'q4_0' },
    backends: { llm: 'cpu' }
  })
  render(<SettingsPanel embedded onClose={() => {}} />)
  const user = userEvent.setup()

  await user.click(await screen.findByRole('button', { name: 'Use fastest settings' }))

  expect(await screen.findByText('Fastest settings on for Apple M5, Metal GPU')).toBeTruthy()
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Chat and vision backend' }).textContent).toContain(
      'Metal'
    )
  )
  await waitFor(
    () => expect(screen.queryByRole('status', { name: 'Fastest settings' })).toBeNull(),
    { timeout: 4000 }
  )
  await user.click(screen.getByRole('button', { name: /^Performance/ }))
  expect(screen.getByRole('button', { name: 'Speculative decoding' }).textContent).toContain('MTP')
})

it('stays out of the way when this machine already runs its fastest settings', async () => {
  installBridge({ llm: {}, backends: {} })
  // Applied earlier, so the row has nothing to offer.
  await (window.api as unknown as { applyBestSettings: () => Promise<unknown> }).applyBestSettings()
  render(<SettingsPanel embedded onClose={() => {}} />)

  await screen.findByRole('button', { name: 'Chat and vision backend' })
  expect(screen.queryByRole('button', { name: 'Use fastest settings' })).toBeNull()
})
