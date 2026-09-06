import { createContext } from 'react'

export interface RendererEntitlement {
  isPro: boolean
  setIsPro: (isPro: boolean) => void
}

export const RendererEntitlementContext = createContext<RendererEntitlement | null>(null)

// Non-React bootstrap code reads this projection while the private renderer
// package is loading. The Provider seeds it before AppContent starts loading
// paid registrations, then updates it before React commits an entitlement loss.
let rendererIsPro = false
let rendererEntitlementInitialized = false

export function getPreloadRendererIsPro(): boolean {
  const api = Reflect.get(window, 'api') as { isPro?: boolean } | undefined
  return api?.isPro === true
}

export function initializeRendererEntitlement(isPro: boolean): boolean {
  rendererEntitlementInitialized = true
  rendererIsPro = isPro
  return isPro
}

export function setRendererIsPro(isPro: boolean): void {
  rendererIsPro = isPro
}

export function getRendererIsPro(): boolean {
  return rendererEntitlementInitialized ? rendererIsPro : getPreloadRendererIsPro()
}

/** A false status removes paid UI only when this renderer had paid access, or
 * when the persisted status proves that a credential existed. This keeps a
 * first-time free install on Models while still sending cold-start expiry and
 * revocation to the purchase screen. Lifetime status stays active because its
 * authoritative `isPro` value is true and its null expiry is never interpreted
 * as a date. */
export function shouldRemovePaidRendererAccess(info: ProLicenseInfo): boolean {
  if (info.isPro !== false) return false
  return getRendererIsPro() || info.expiry !== null || info.verifiedAt > 0
}
