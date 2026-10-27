import { useEffect } from 'react'
import { useToast } from '../hooks/useToast'

const ENGINE_NAME = { parakeet: 'Parakeet', 'qwen3-asr': 'Qwen3-ASR' } as const

/** Says so when Parakeet or Qwen3-ASR failed on a recording and Whisper transcribed it instead. */
export function TranscriptionFallbackNotice(): null {
  const { showToast } = useToast()
  useEffect(
    () =>
      window.api.onTranscriptionFallback((notice) =>
        showToast({
          message: `${ENGINE_NAME[notice.engine]} couldn't transcribe that, so Whisper did.`,
          tone: 'neutral'
        })
      ),
    [showToast]
  )
  return null
}
