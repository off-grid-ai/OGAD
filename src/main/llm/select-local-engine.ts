import { nativeLadder, type NativeStep } from '../backend-facts'

/** Grounding, decision and chat share the native backend policy. */
export function selectLocalEngines(
  modality: 'grounding' | 'decision' | 'llm'
): Promise<NativeStep[]> {
  return nativeLadder(modality)
}
