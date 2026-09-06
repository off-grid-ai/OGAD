import { CATALOG, primaryFileName } from '@offgrid/models'
import { describe, expect, it } from 'vitest'
import { desktopImageRuntimeIdentity } from '../image-runtime-identity'

describe('Desktop image runtime identity adapter', () => {
  it('projects one Shared catalog id to the native primary artifact', () => {
    const entry = CATALOG.find((model) => model.kind === 'image' && model.runtime !== 'mflux')
    if (!entry) throw new Error('The Shared catalog needs one file-backed image model')

    expect(desktopImageRuntimeIdentity.resolve(entry.id)).toBe(primaryFileName(entry))
    expect(desktopImageRuntimeIdentity.resolve(entry.id, entry)).toBe(primaryFileName(entry))
  })

  it('preserves an unknown native identity instead of inventing a second mapping', () => {
    expect(desktopImageRuntimeIdentity.resolve('local-image.safetensors')).toBe(
      'local-image.safetensors'
    )
  })
})
