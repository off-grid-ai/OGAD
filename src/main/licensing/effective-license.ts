import type { ProLicenseInfo } from './license-service'

/** Keep every renderer license projection aligned with the main-process gate.
 * Development Pro overrides are effective entitlements even without a stored
 * provider credential; packaged builds still use the provider result. */
export function effectiveProLicenseInfo(info: ProLicenseInfo, enabled: boolean): ProLicenseInfo {
  return info.isPro === enabled ? info : { ...info, isPro: enabled }
}
