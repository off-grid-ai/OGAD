// The ONE impure step in assembling a multimodal turn: reading image bytes off disk.
//
// It lived twice - a private decodeImages() in llm.ts for the plain chat path, and an inline
// readFileSync/base64/mime loop in tools.ts for the agentic path. Two copies of "turn a path into
// something the model server can read" drift: the tools copy also skipped the surrogate repair that
// chat-payload calls essential, so the same attachment produced a different request depending on
// whether the composer had tools switched on.
//
// chat-payload.ts stays pure and takes the DECODED images this returns.

import fs from 'node:fs'
import { imageMime, type DecodedImage } from './chat-payload'

/**
 * Read each image path into base64 + MIME, in order.
 *
 * A path that cannot be read is skipped rather than throwing: one unreadable attachment must not
 * lose the user's whole turn. The caller decides what an empty result means.
 */
export function readImages(paths: string[]): DecodedImage[] {
  const decoded: DecodedImage[] = []
  for (const imgPath of paths) {
    try {
      decoded.push({
        base64: fs.readFileSync(imgPath).toString('base64'),
        mime: imageMime(imgPath)
      })
    } catch (readErr) {
      console.error(`[readImages] Failed to read image ${imgPath}:`, readErr)
    }
  }
  return decoded
}
