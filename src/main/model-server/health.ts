type GatewayModalityStatus = 'ready' | 'not_installed'

export interface GatewayCapabilityFacts {
  chat: boolean
  vision: boolean
  embeddings: boolean
  transcription: boolean
  speech: boolean
  image: boolean
  video?: boolean
}

export type GatewayModalities = Record<
  | 'text'
  | 'vision_understanding'
  | 'embeddings'
  | 'transcription'
  | 'speech'
  | 'image_generation'
  | 'image_edit'
  | 'video_generation',
  GatewayModalityStatus
>

/** Convert live runtime facts into the one modality contract shared by health and OpenAPI. */
export function buildGatewayModalities(facts: GatewayCapabilityFacts): GatewayModalities {
  const status = (available: boolean): GatewayModalityStatus =>
    available ? 'ready' : 'not_installed'
  return {
    text: status(facts.chat),
    vision_understanding: status(facts.vision),
    embeddings: status(facts.embeddings),
    transcription: status(facts.transcription),
    speech: status(facts.speech),
    image_generation: status(facts.image),
    image_edit: status(facts.image),
    video_generation: status(facts.video === true)
  }
}
