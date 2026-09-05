// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { SoftwareUpdateSection } from '../SoftwareUpdateSection'

afterEach(cleanup)

type UpdateProgressPayload = {
  transferred: number
  total: number
  bytesPerSecond?: number
  percent: number
  status: 'downloading' | 'completed' | 'failed'
  version: string | null
}

it('shows bytes and rate through the shared formatter with honest unknowns', async () => {
  let progress!: (value: UpdateProgressPayload) => void
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      updateGetPrefs: async () => ({ currentVersion: '1.0.0', auto: true, channel: 'stable' }),
      updateDownloadProgress: async () => null,
      onUpdateDownloadProgress: (listener: typeof progress) => {
        progress = listener
        return () => undefined
      }
    }
  })
  render(<SoftwareUpdateSection />)
  await waitFor(() => expect(progress).toBeTypeOf('function'))

  // Unknown total (0 from the updater) and no measured rate: never print empty strings.
  act(() =>
    progress({
      transferred: 1_000_000,
      total: 0,
      percent: 0,
      status: 'downloading',
      version: '1.1.0'
    })
  )
  const unknownText = screen.getByText(/Downloading v1\.1\.0/).parentElement!.parentElement!
    .textContent
  expect(unknownText).toContain('1 MB downloaded - Total size unavailable')
  expect(unknownText).toContain('Rate unavailable')

  act(() =>
    progress({
      transferred: 2_048_576,
      total: 4_097_152,
      bytesPerSecond: 1_048_576,
      percent: 50,
      status: 'downloading',
      version: '1.1.0'
    })
  )
  const knownText = screen.getByText(/Downloading v1\.1\.0/).parentElement!.parentElement!
    .textContent
  expect(knownText).toContain('50%')
  expect(knownText).toContain('2 MB of 4 MB')
  expect(knownText).toContain('1.0 MB/s')
})
