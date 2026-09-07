import sharp from 'sharp'

/** A valid NativeImage can still be a single-color failed render. Measure the
 * pixels so that blank black/white pages do not become model evidence. */
export async function browserPageHasVisualContent(png: Buffer): Promise<boolean> {
  const { channels } = await sharp(png).stats()
  return channels.some((channel) => channel.stdev >= 2)
}
