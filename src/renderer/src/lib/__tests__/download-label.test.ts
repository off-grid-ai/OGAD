import { describe, it, expect } from 'vitest'
import { companionDownloadLabel, modelSetupErrorMessage } from '../download-label'

describe('model setup recovery copy', () => {
  it.each([
    ['EACCES: permission denied /private/models', 'choose a writable model folder'],
    ['EPERM: operation not permitted', 'choose a writable model folder'],
    ['read-only file system', 'choose a writable model folder'],
    ['ENOSPC: no space left on device', 'Free some storage'],
    ['ECONNRESET at https://example.test/private?token=secret', 'Check your connection'],
    ['HTTP 503', 'Check your connection'],
    ['unexpected native failure /private/models', 'Technical details are in the app log']
  ])('gives a recovery action for %s without leaking diagnostics', (error, action) => {
    const message = modelSetupErrorMessage(error)
    expect(message).toContain(action)
    expect(message).not.toMatch(/\/private|token=|EACCES|EPERM|ENOSPC|ECONNRESET|HTTP 503/)
  })
  it('preserves plan validation and distinguishes cancellation', () => {
    expect(modelSetupErrorMessage('Select at least one model.')).toBe('Select at least one model.')
    expect(modelSetupErrorMessage('The setup plan changed. Review the new plan.')).toBe(
      'The setup plan changed. Review the new plan.'
    )
    expect(modelSetupErrorMessage('Download canceled')).toBe('Download canceled.')
  })
})

describe('companionDownloadLabel', () => {
  it('labels a vision projector so it does not read as a full re-download', () => {
    expect(companionDownloadLabel('mmproj-gemma-4-E2B-it-F16.gguf')).toBe('vision projector')
    expect(companionDownloadLabel('mmproj-BF16.gguf')).toBe('vision projector')
    expect(companionDownloadLabel('clip-vit.gguf')).toBe('vision projector')
  })
  it('returns null for primary weights (no special label) and empty input', () => {
    expect(companionDownloadLabel('gemma-4-E2B-it-Q4_K_M.gguf')).toBeNull()
    expect(companionDownloadLabel(undefined)).toBeNull()
    expect(companionDownloadLabel(null)).toBeNull()
    expect(companionDownloadLabel('')).toBeNull()
  })
})
