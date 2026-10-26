import fs from 'node:fs'
import { readGeneratedImageReference } from '../../shared/generated-image-reference'

/** One stored chat message, as far as finding its image needs. */
export interface ChatImageRow {
  context: string | null
}

/** The image a message shows: a generated image, else the last image the user attached. */
export function messageImagePath(context: string | null): string | undefined {
  if (!context) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(context)
  } catch {
    return undefined
  }
  const generated = readGeneratedImageReference(parsed)?.path
  if (generated) return generated
  const attachments = (parsed as { attachments?: unknown } | null)?.attachments
  if (!Array.isArray(attachments)) return undefined
  for (let index = attachments.length - 1; index >= 0; index--) {
    const item = attachments[index] as { kind?: unknown; path?: unknown } | null
    if (item?.kind === 'image' && typeof item.path === 'string' && item.path) return item.path
  }
  return undefined
}

/** The newest image in a chat whose file is still on this device. */
export function lastChatImagePath(
  rows: readonly ChatImageRow[],
  exists: (file: string) => boolean = fs.existsSync
): string | undefined {
  for (let index = rows.length - 1; index >= 0; index--) {
    const file = messageImagePath(rows[index]?.context ?? null)
    if (file && exists(file)) return file
  }
  return undefined
}
