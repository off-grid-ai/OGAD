import type { ComponentType } from 'react'
import {
  getRegisteredFeatures,
  hasFeatureNavigation,
  registerFeatureNavigation,
  type FeatureNavigation
} from './featureRegistry'

// Navigation seam. Pro registers sidebar nav entries during activation; App.tsx
// renders core items + registered items in order. Each entry points at a route
// name that a registered screen (screenRegistry) renders.
//
// Note: the FREE build also shows pro entries — sourced from the static pro
// catalog (see components/pro/proCatalog.ts) — as locked upsell items. This
// registry is only populated when the pro package is actually activated, so a
// route present here = unlocked.

export interface NavEntry {
  /** Route name, matches a RegisteredScreen.name. */
  route: string
  /** Sidebar label. */
  label: string
  /** Phosphor icon component. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: ComponentType<any>
  /** Lower sorts first; core items use 0..99, pro items 100+. */
  order?: number
}

const legacyProRoutes = new Set<string>()

export function registerNav(entry: NavEntry): () => void {
  if (hasFeatureNavigation(entry.route)) return () => {}
  const unregister = registerFeatureNavigation(entry as FeatureNavigation)
  legacyProRoutes.add(entry.route)
  return () => {
    unregister()
    legacyProRoutes.delete(entry.route)
  }
}

export function getRegisteredNav(): NavEntry[] {
  return getRegisteredFeatures().map(({ route, label, icon, order }) => ({
    route,
    label,
    icon,
    order
  }))
}

/** Compatibility signal retained for the private package activation API. */
export function isProActive(): boolean {
  return legacyProRoutes.size > 0
}
