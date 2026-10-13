// The wire body includes base64 ciphertext (with a 16-byte GCM tag) and JSON metadata.
export const MAX_SEALED_REQUEST_BYTES = 4 * 1024 * 1024
export const MAX_SEALED_RESPONSE_BYTES = MAX_SEALED_REQUEST_BYTES
export const SEALED_METADATA_BYTES = 1024
export const MAX_RPC_PLAINTEXT_BYTES =
  Math.floor((MAX_SEALED_REQUEST_BYTES - SEALED_METADATA_BYTES) / 4) * 3 - 16
// Audio is base64 inside JSON, which is base64 again after sealing. Reserve JSON space.
export const MAX_TRANSCRIBE_AUDIO_BYTES =
  Math.floor((MAX_RPC_PLAINTEXT_BYTES - SEALED_METADATA_BYTES) / 4) * 3
export const MAX_SPEAK_TEXT_CHARS = 8000

export function fitsSealedResponse(result: unknown): boolean {
  const plaintext = Buffer.byteLength(JSON.stringify(result)) + SEALED_METADATA_BYTES
  return 4 * Math.ceil((plaintext + 16) / 3) + SEALED_METADATA_BYTES <= MAX_SEALED_RESPONSE_BYTES
}
