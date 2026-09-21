import { describe, expect, it } from 'vitest'
import {
  classifyCaptureFailure,
  computerUsePreflight,
  type ComputerUsePreflightInput
} from '../computer-use-preflight'

const ready: ComputerUsePreflightInput = {
  accessibilityAvailable: true,
  capturePermission: true,
  displayAvailable: true,
  targetWindowAvailable: true,
  inputActuationAvailable: true,
  decisionModelAvailable: true,
  decisionRuntimeAvailable: true,
  specialistRequired: false,
  specialistAvailable: true,
  remoteCapabilityRequired: false,
  remoteCapabilityAvailable: true
}

describe('Computer Use admission classification', () => {
  it('keeps display unavailable separate from capture permission', () => {
    expect(computerUsePreflight({ ...ready, displayAvailable: false })).toEqual({
      ok: false,
      failure: 'display_unavailable',
      countsAsPolicyFailure: false
    })
    expect(computerUsePreflight({ ...ready, capturePermission: false })).toEqual({
      ok: false,
      failure: 'capture_permission_missing',
      countsAsPolicyFailure: false
    })
    expect(classifyCaptureFailure('No display was found.')).toBe('display_unavailable')
    expect(classifyCaptureFailure('Screen Recording permission is denied.')).toBe(
      'capture_permission_missing'
    )
  })

  it('fails missing remote tool capability before policy evaluation', () => {
    expect(
      computerUsePreflight({
        ...ready,
        remoteCapabilityRequired: true,
        remoteCapabilityAvailable: false
      })
    ).toEqual({ ok: false, failure: 'remote_capability_missing', countsAsPolicyFailure: false })
  })

  it('admits a complete target-bound setup', () => {
    expect(computerUsePreflight(ready)).toEqual({ ok: true })
  })
})
