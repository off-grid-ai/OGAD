// Residency policy for the on-device model runtimes. Each modality can run in one
// of two modes, user-selectable in settings and enforced by the ModalityQueue:
//
//   'resident'  — the model stays warm in memory between jobs (low latency), and is
//                 evicted ONLY when another modality needs the RAM (queue admission),
//                 then re-warmed when the slot frees.
//   'on-demand' — the model loads for a job and is freed right after (frees RAM,
//                 higher per-job latency). The default for the heavy image/STT paths.
//
// Concrete engines map onto these: LLM = llama-server; image = sd-cli/sd-server or
// mflux; STT = whisper-cli / whisper-server (resident) / parakeet; TTS = kokoro.
//
// Pure policy lives in @offgrid/models. This module is the thin SQLite
// settings wrapper used by production runtimes.

import { getSetting, saveSetting } from './database'
import {
  isRuntimeResidencyLocked as isResidencyLocked,
  normalizeRuntimeResidency as normalizeResidency,
  type RuntimeModality as Modality,
  type PersistedResidencyPreference as ResidencyMode
} from '@offgrid/models'
export type {
  RuntimeModality as Modality,
  PersistedResidencyPreference as ResidencyMode
} from '@offgrid/models'

const SETTING_KEY = 'runtime:residency'

/** The full residency map (persisted, defaults applied). */
export function getResidency(): Record<Modality, ResidencyMode> {
  return normalizeResidency(getSetting<unknown>(SETTING_KEY, {}))
}

/** The residency mode for one modality. */
export function getResidencyMode(modality: Modality): ResidencyMode {
  return getResidency()[modality]
}

/** Persist the mode for one modality, returning the updated full map. A locked
 *  modality (e.g. the chat model) ignores the requested mode and stays resident. */
export function setResidencyMode(
  modality: Modality,
  mode: ResidencyMode
): Record<Modality, ResidencyMode> {
  const effective = isResidencyLocked(modality) ? 'resident' : mode
  const next = { ...getResidency(), [modality]: effective }
  saveSetting(SETTING_KEY, next)
  return next
}
