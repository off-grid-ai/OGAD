import { describe, expect, it } from 'vitest'
import {
  IMAGE_MEMORY_GUARD_ERROR_CODE,
  imageModelAdmissionMessage,
  imageMemoryGuardErrorMessage,
  parseImageMemoryGuardError
} from '../image-generation-contract'

describe('image memory guard IPC contract', () => {
  it('recovers the user-facing message after an Electron invoke wrapper', () => {
    const encoded = imageMemoryGuardErrorMessage('Not enough memory for this model.')
    const wrapped = new Error(`Error invoking remote method: Error: ${encoded}`)

    expect(parseImageMemoryGuardError(wrapped)).toEqual({
      code: IMAGE_MEMORY_GUARD_ERROR_CODE,
      message: 'Not enough memory for this model.'
    })
  })

  it('does not classify unrelated generation failures as memory overrides', () => {
    expect(parseImageMemoryGuardError(new Error('Image engine failed to load.'))).toBeNull()
  })

  it('gives an actionable message for a refused image residency admission', () => {
    expect(imageModelAdmissionMessage('DreamShaper XL')).toBe(
      'Not enough free memory to load DreamShaper XL safely. Choose a smaller image model, or use Run anyway.'
    )
  })
})
