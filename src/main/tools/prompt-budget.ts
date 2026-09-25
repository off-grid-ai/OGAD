import { toolPromptChars as serializedToolPromptChars } from '@offgrid/models'

// llama.cpp accounts for an image as vision embeddings, not as the characters in
// its base64 transport. Keep the existing conservative four-characters-per-token
// budget, but replace each embedded image with a fixed vision allowance first.
// 2K tokens leaves useful text and tool room in a 16K context and is deliberately
// larger than the image-token use observed from the supported vision models.
const VISION_IMAGE_ESTIMATE_CHARS = 2_048 * 4
const VISION_IMAGE_PLACEHOLDER = `data:image/estimated;base64,${'x'.repeat(
  VISION_IMAGE_ESTIMATE_CHARS
)}`

function projectVisionPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectVisionPayload)
  if (!value || typeof value !== 'object') return value

  const projected: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      key === 'url' &&
      typeof child === 'string' &&
      /^data:image\/[a-z0-9.+-]+;base64,/i.test(child)
    ) {
      projected[key] = VISION_IMAGE_PLACEHOLDER
    } else {
      projected[key] = projectVisionPayload(child)
    }
  }
  return projected
}

/** Serialized prompt size with inline image bytes charged as vision tokens. */
export function toolPromptChars(messages: unknown, tools?: unknown): number {
  return serializedToolPromptChars(
    projectVisionPayload(messages) as Parameters<typeof serializedToolPromptChars>[0],
    projectVisionPayload(tools) as Parameters<typeof serializedToolPromptChars>[1]
  )
}
