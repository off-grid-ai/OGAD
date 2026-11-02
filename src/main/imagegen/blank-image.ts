import fs from 'node:fs'
import sharp from 'sharp'

/** A diffusion graph whose latents went non-finite still decodes: every pixel saturates to one colour
 *  (pure white on Metal when ggml's GroupNorm skipped the second image of sd.cpp's batched CFG pass).
 *  No real picture is one flat colour, so such a frame counts as a failed run. */
export async function isBlankImage(image: Buffer | string): Promise<boolean> {
  // A path is read here, not handed to sharp: libvips caches decoded files by path, and the engine
  // ladder rewrites the same output file on each attempt, so a path would return the stale frame.
  const bytes = typeof image === 'string' ? await fs.promises.readFile(image) : image
  const { channels } = await sharp(bytes).stats()
  return channels.every((channel) => channel.min === channel.max)
}

export const BLANK_IMAGE_MESSAGE =
  'The image engine returned a blank picture (one flat colour). Try again, or pick another image model.'
