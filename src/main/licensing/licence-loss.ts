// Why this computer lost Pro, kept until Pro is back, so the Pro page can say it instead of
// showing the plain buy page. Today one cause is recorded here: another device removed this one
// from the license. An ended license needs no note: its end date stays in the license status.
import { getSettings, saveSetting } from '../database'

const KEY = 'licenceRemovedBy'

/** Another device removed this one. `by` is its name, or '' when it is not known. */
export function noteLicenceRemoved(by: string): void {
  saveSetting(KEY, by.trim().slice(0, 80))
}

/** The removing device's name ('' when unknown), or null when this device was not removed. */
export function licenceRemovedBy(): string | null {
  const value = (getSettings() as Record<string, unknown>)[KEY]
  return typeof value === 'string' ? value : null
}

/** Pro is back: the note has done its job. */
export function clearLicenceLoss(): void {
  if (licenceRemovedBy() !== null) saveSetting(KEY, null)
}
