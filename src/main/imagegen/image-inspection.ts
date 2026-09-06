import fs from 'node:fs'

export function imageFileSizeGb(filePath: string | null | undefined): number {
  try {
    return filePath ? fs.statSync(filePath).size / 1e9 : 0
  } catch {
    return 0
  }
}

export async function inspectSourceDimensions(
  sourceImageUri: string | undefined
): Promise<{ width: number; height: number } | undefined> {
  if (!sourceImageUri) return undefined
  try {
    const { default: sharp } = await import('sharp')
    const metadata = await sharp(sourceImageUri).metadata()
    return metadata.width && metadata.height
      ? { width: metadata.width, height: metadata.height }
      : undefined
  } catch {
    return undefined
  }
}
