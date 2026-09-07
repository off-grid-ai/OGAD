import { describe, expect, it } from 'vitest'
import { computerUsePermissionBlock } from '../computer-use-permissions'

describe('Computer Use permission preflight', () => {
  it('reports every missing macOS permission in one actionable result', () => {
    expect(
      computerUsePermissionBlock({
        platform: 'darwin',
        accessibilityGranted: false,
        screenRecordingGranted: false
      })
    ).toMatch(/Screen Recording and Accessibility/)
  })

  it('allows macOS only when capture and actuation are both granted', () => {
    expect(
      computerUsePermissionBlock({
        platform: 'darwin',
        accessibilityGranted: true,
        screenRecordingGranted: true
      })
    ).toBeNull()
  })

  it('does not apply macOS permission names to other platforms', () => {
    expect(
      computerUsePermissionBlock({
        platform: 'win32',
        accessibilityGranted: false,
        screenRecordingGranted: false
      })
    ).toBeNull()
  })
})
