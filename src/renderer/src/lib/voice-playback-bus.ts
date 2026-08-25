const playBus = new EventTarget()

/** Pause every voice bubble when the active chat changes. */
export function stopAllVoicePlayback(): void {
  playBus.dispatchEvent(new CustomEvent('play', { detail: '__stop_all__' }))
}

/** Claim the single voice-playback slot for one message. */
export function claimVoicePlayback(messageId: string): void {
  playBus.dispatchEvent(new CustomEvent('play', { detail: messageId }))
}

/** Subscribe to playback claims without exposing the transport to the UI. */
export function onVoicePlaybackClaim(listener: (messageId: string) => void): () => void {
  const onPlay = (event: Event): void => listener((event as CustomEvent<string>).detail)
  playBus.addEventListener('play', onPlay)
  return () => playBus.removeEventListener('play', onPlay)
}
