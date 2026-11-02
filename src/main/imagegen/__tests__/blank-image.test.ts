/**
 * A numerically failed diffusion graph still decodes, to one saturated colour: on a Mac every SDXL
 * picture came back pure white when ggml's Metal GroupNorm skipped the second image of sd.cpp's
 * batched CFG pass. Real PNGs, built by sharp, read back by the same check the runtime uses.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { isBlankImage } from '../blank-image'

const flat = (r: number, g: number, b: number, channels: 3 | 4 = 3): Promise<Buffer> =>
  sharp({
    create: { width: 64, height: 64, channels, background: { r, g, b, alpha: 1 } }
  })
    .png()
    .toBuffer()

describe('isBlankImage', () => {
  it('counts any one-colour frame as blank: white, grey, with or without alpha', async () => {
    expect(await isBlankImage(await flat(255, 255, 255))).toBe(true)
    expect(await isBlankImage(await flat(128, 128, 128))).toBe(true)
    expect(await isBlankImage(await flat(255, 255, 255, 4))).toBe(true)
  })

  it('counts a picture as an image, down to one differing pixel', async () => {
    const pixels = Buffer.alloc(64 * 64 * 3, 255)
    pixels[pixels.length - 1] = 254
    const onePixel = await sharp(pixels, { raw: { width: 64, height: 64, channels: 3 } })
      .png()
      .toBuffer()
    expect(await isBlankImage(onePixel)).toBe(false)
  })

  it('reads the file as it is now when an engine retry rewrites the same output path', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'blank-image-')), 'out.png')
    fs.writeFileSync(file, await flat(255, 255, 255))
    expect(await isBlankImage(file)).toBe(true)
    const pixels = Buffer.alloc(64 * 64 * 3, 255)
    pixels[0] = 0
    fs.writeFileSync(
      file,
      await sharp(pixels, { raw: { width: 64, height: 64, channels: 3 } })
        .png()
        .toBuffer()
    )
    expect(await isBlankImage(file)).toBe(false)
  })
})
