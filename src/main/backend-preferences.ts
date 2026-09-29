import { getSetting, saveSetting } from './database'
import {
  BACKEND_MODALITIES,
  backendChoices,
  normalizeBackendPreferences,
  type BackendModality,
  type BackendPreference,
  type BackendPreferences
} from '../shared/backend-preferences'

const KEY = 'runtime:backend-preferences'

export function getBackendPreferences(): BackendPreferences {
  return normalizeBackendPreferences(getSetting<unknown>(KEY, {}), process.platform)
}

export function getBackendPreference(modality: BackendModality): BackendPreference {
  return getBackendPreferences()[modality]
}

export function setBackendPreference(
  modality: BackendModality,
  preference: BackendPreference
): BackendPreferences {
  if (!BACKEND_MODALITIES.includes(modality) ||
      !backendChoices(modality, process.platform).includes(preference)) {
    throw new Error('Invalid model backend setting')
  }
  const next = { ...getBackendPreferences(), [modality]: preference }
  saveSetting(KEY, next)
  return next
}
