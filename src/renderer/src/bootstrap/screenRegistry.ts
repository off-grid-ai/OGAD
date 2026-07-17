import type { ComponentType } from 'react'
import {
  getRegisteredFeature,
  getRegisteredFeatures,
  registerFeatureScreen
} from './featureRegistry'

// Screen seam. Pro registers full screens (route name → component) during
// activation; App.tsx renders core screens + whatever is registered. Free build
// registers nothing. Mirrors mobile/src/navigation/screenRegistry.ts.

export interface RegisteredScreen {
  /** Route name, e.g. 'day', 'entities', 'connectors'. */
  name: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>
}

export function registerScreen(screen: RegisteredScreen): () => void {
  return registerFeatureScreen(screen)
}

export function getRegisteredScreen(name: string): RegisteredScreen | undefined {
  const feature = getRegisteredFeature(name)
  return feature ? { name: feature.route, component: feature.component } : undefined
}

export function getRegisteredScreens(): RegisteredScreen[] {
  return getRegisteredFeatures().map(({ route, component }) => ({ name: route, component }))
}
