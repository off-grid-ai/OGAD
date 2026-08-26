import { describe, expect, it } from 'vitest'
import { mayUseIsolatedEvidenceInstance } from '../isolated-evidence-instance'

describe('mayUseIsolatedEvidenceInstance', () => {
  it('requires the explicit flag and a profile below the temporary root', () => {
    expect(
      mayUseIsolatedEvidenceInstance(
        {
          OFFGRID_E2E_ISOLATED_INSTANCE: '1',
          OFFGRID_USER_DATA: '/tmp/offgrid-evidence-agentic-studio-123'
        },
        '/tmp'
      )
    ).toBe(true)
    expect(
      mayUseIsolatedEvidenceInstance(
        { OFFGRID_USER_DATA: '/tmp/offgrid-evidence-agentic-studio-123' },
        '/tmp'
      )
    ).toBe(false)
    expect(
      mayUseIsolatedEvidenceInstance(
        {
          OFFGRID_E2E_ISOLATED_INSTANCE: '1',
          OFFGRID_USER_DATA: '/Users/user/Library/Application Support/Off Grid AI Desktop'
        },
        '/tmp'
      )
    ).toBe(false)
  })
})
