import { describe, it, expect } from 'vitest'
import type { PublicDownloadInfo } from '@offgrid/application'
import { companionDownloadLabel } from '../download-label'

type FileRole = NonNullable<PublicDownloadInfo['currentFileRole']>

/** Every role in the Shared union that is NOT a companion label. The `Record` makes
 *  the list exhaustive: adding a role to the union fails typecheck here until the
 *  label decision for it is made. */
const NON_COMPANION_ROLES: Record<Exclude<FileRole, 'mmproj'>, true> = {
  primary: true,
  tokenizer: true,
  aux: true
}

describe('companionDownloadLabel', () => {
  it('labels a vision projector so it does not read as a full re-download', () => {
    expect(companionDownloadLabel('mmproj')).toBe('Vision support (mmproj)')
  })

  it.each(Object.keys(NON_COMPANION_ROLES) as Exclude<FileRole, 'mmproj'>[])(
    'returns null for the %s role (no special label)',
    (role) => {
      expect(companionDownloadLabel(role)).toBeNull()
    }
  )

  it('returns null when the owner has not reported a role yet (undefined, null, omitted)', () => {
    expect(companionDownloadLabel(undefined)).toBeNull()
    expect(companionDownloadLabel(null)).toBeNull()
    expect(companionDownloadLabel()).toBeNull()
  })

  it('returns null for a role value the renderer does not recognise', () => {
    expect(companionDownloadLabel('lora' as unknown as FileRole)).toBeNull()
  })
})
