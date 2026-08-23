import { describe, expect, it } from 'vitest'
import { verifyImageDecodable, type ImageProbe } from '../files-image-probe'

describe('image decode verification', () => {
  it('distinguishes a valid image, damaged bytes, and an unavailable native checker', async () => {
    const valid: ImageProbe = () => ({ metadata: async () => ({ width: 16, height: 16 }) })
    const damaged: ImageProbe = () => ({
      metadata: async () => {
        throw new Error('invalid image header')
      }
    })

    await expect(verifyImageDecodable('/image.png', async () => valid)).resolves.toBe('decodable')
    await expect(verifyImageDecodable('/broken.png', async () => damaged)).resolves.toBe(
      'undecodable'
    )
    await expect(verifyImageDecodable('/unchecked.png', async () => null)).resolves.toBe(
      'unchecked'
    )
  })
})
