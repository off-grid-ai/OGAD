import type { VisionPolicyMessage } from './types'

/** Persist exact policy messages without storing the screenshot bytes. */
export function serializeVisionPolicyMessages(messages: readonly VisionPolicyMessage[]): string {
  return JSON.stringify(
    messages.map((message) => ({
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map((part) =>
            part.type === 'image_url'
              ? { type: 'image_url', image_url: { url: '[current screenshot]' } }
              : part
          )
        : message.content
    }))
  )
}
