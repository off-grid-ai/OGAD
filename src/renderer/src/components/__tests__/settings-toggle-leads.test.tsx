// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AnalyticsPanel } from '../analytics/AnalyticsPanel'
import { SoftwareUpdateSection } from '../SoftwareUpdateSection'

afterEach(cleanup)

/** The switch comes before its own label, in the same row. */
function expectToggleLeads(name: string): void {
  const toggle = screen.getByRole('switch', { name })
  const row = toggle.closest('[data-slot="setting-row"]') as HTMLElement
  const label = Array.from(row.querySelectorAll('span')).find((el) => el.textContent === name)
  expect(label).toBeTruthy()
  expect(toggle.compareDocumentPosition(label!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
}

describe('settings toggles lead their rows', () => {
  it('puts each analytics switch before its own label', () => {
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      analytics: { consent: { usage: true, crashes: true } }
    }
    render(<AnalyticsPanel />)
    expectToggleLeads('Anonymous stats')
    expectToggleLeads('Crash reports')
  })

  it('puts each software update switch before its own label', () => {
    ;(window as unknown as { api: Record<string, unknown> }).api = {}
    render(<SoftwareUpdateSection />)
    expectToggleLeads('Automatic updates')
    expectToggleLeads('Nightly builds')
  })
})
