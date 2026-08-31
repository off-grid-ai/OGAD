import type { TranscribeOptions } from '../transcription/types'

export function transcriptionRequestOptions(
  fields: Record<string, string>
): Pick<TranscribeOptions, 'language' | 'model'> {
  const language = fields.language?.trim().toLowerCase()
  if (language && language !== 'auto' && !/^[a-z]{2}$/.test(language)) {
    throw new Error('Unsupported transcription language')
  }
  const model = fields.model?.trim()
  return {
    ...(model ? { model } : {}),
    ...(language && language !== 'auto' ? { language } : {})
  }
}
