import { useContext } from 'react'
import {
  getPreloadRendererIsPro,
  RendererEntitlementContext,
  type RendererEntitlement
} from './entitlementRegistry'

/** Renderer components use this projection instead of the preload's launch-only
 * `isPro` snapshot. Outside App (small component tests), the launch snapshot is
 * still the correct fallback. */
export function useRendererEntitlement(): RendererEntitlement {
  const context = useContext(RendererEntitlementContext)
  if (context) return context
  return {
    isPro: getPreloadRendererIsPro(),
    setIsPro: () => {}
  }
}
