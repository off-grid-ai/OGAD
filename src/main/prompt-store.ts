import { deleteSetting, getSetting, saveSetting } from './database'
import { registeredPromptKey } from '@offgrid/models'

/** Reads the Desktop-owned override. Shared owns defaults and expansion. */
export function getPromptOverride(key: string): string | null {
  return getSetting<string | null>(`prompt:${registeredPromptKey(key)}`, null)
}

export function savePromptOverride(key: string, value: string): void {
  saveSetting(`prompt:${registeredPromptKey(key)}`, value)
}

/** Deletes a custom override so the prompt reverts to its default. */
export function resetPromptOverride(key: string): void {
  deleteSetting(`prompt:${registeredPromptKey(key)}`)
}
