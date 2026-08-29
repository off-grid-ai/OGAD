export const HINDI_SCRIPT_RECOVERY_MESSAGE =
  'Hindi transcription used the wrong script. Install Whisper Small, Medium, or Large in Models > Transcription, then try again.'

export function transcriptionRecoveryMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(HINDI_SCRIPT_RECOVERY_MESSAGE) ? HINDI_SCRIPT_RECOVERY_MESSAGE : null
}
