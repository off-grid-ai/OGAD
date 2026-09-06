// Renderer composition root: the shared speech endpoint timer over one capture's end callback.
import { SpeechEndpointTimer } from '@offgrid/speech'

export function createSpeechEndpointTimer(onEnded: () => void): SpeechEndpointTimer {
  return new SpeechEndpointTimer(onEnded)
}
