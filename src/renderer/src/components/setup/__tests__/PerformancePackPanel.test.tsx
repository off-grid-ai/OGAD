// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { PerformancePackPanel } from '../PerformancePackPanel'
import type { PerformancePackStatus } from '../../../../../shared/performance-pack'

afterEach(cleanup)

function showPack(platform: string, status: PerformancePackStatus): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    platform,
    performancePack: {
      status: async () => status,
      onChanged: () => () => {}
    }
  }
  render(<PerformancePackPanel showUnavailable />)
}

it('explains that macOS needs no optional CUDA download', async () => {
  showPack('darwin', { phase: 'unavailable', bytes: 0, downloadedBytes: 0 })
  expect(await screen.findByText('Metal support is included on macOS. No extra GPU download is needed.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
})

it('shows Computer Use grounding and decision engines in the NVIDIA download', async () => {
  showPack('linux', { phase: 'available', bytes: 1024, downloadedBytes: 0 })
  expect(await screen.findByText('Computer Use')).toBeTruthy()
  expect(screen.getByText('NVIDIA grounding and decision engines')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
})
