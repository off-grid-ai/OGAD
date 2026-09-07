import fs from 'node:fs'
import path from 'node:path'
import { resourceDirs } from '../runtime-env'

export function listStyleThumbs(): Record<string, string> {
  const thumbnails: Record<string, string> = {}
  for (const resources of resourceDirs()) {
    const directory = path.join(resources, 'style-thumbs')
    try {
      for (const file of fs.readdirSync(directory)) {
        const match = file.match(/^(.+)\.(png|jpe?g|webp)$/i)
        if (match && !thumbnails[match[1]!]) {
          thumbnails[match[1]!] = path.join(directory, file)
        }
      }
    } catch {
      /* this resource root does not contain style previews */
    }
  }
  return thumbnails
}
