import { useSyncExternalStore, type ComponentType } from 'react'

export interface FeatureIconProps {
  className?: string
}

export interface RegisteredFeature {
  route: string
  label: string
  icon: ComponentType<FeatureIconProps>
  component: ComponentType
  /** Lower values render earlier among package-owned navigation entries. */
  order?: number
}

export interface PublishedFeature extends RegisteredFeature {
  kind: 'core' | 'legacy-pro'
}

export interface FeatureNavigation {
  route: string
  label: string
  icon: ComponentType<FeatureIconProps>
  order?: number
}

export interface FeatureScreen {
  name: string
  component: ComponentType
}

interface PendingFeature {
  navigation?: OwnedRegistration<FeatureNavigation>
  screen?: OwnedRegistration<FeatureScreen>
}

interface OwnedRegistration<T> {
  owner: symbol
  kind: PublishedFeature['kind']
  value: T
}

const pendingFeatures = new Map<string, PendingFeature>()
const listeners = new Set<() => void>()
let snapshot: readonly PublishedFeature[] = []
let coreSnapshot: readonly PublishedFeature[] = []

/** Routes composed directly by App.tsx or its existing Pro fallback. Packages
 * must choose a distinct route so their navigation cannot be silently shadowed. */
const HOST_OWNED_ROUTES = new Set([
  'dashboard',
  'day',
  'replay',
  'reflect',
  'actions',
  'connectors',
  'meetings',
  'chats',
  'memories',
  'entities',
  'graph',
  'memory-chat',
  'models',
  'gateway',
  'projects',
  'notifications',
  'settings',
  'search',
  'clipboard',
  'voice',
  'vault'
])

function publish(): void {
  snapshot = Object.freeze(
    [...pendingFeatures.values()]
      .flatMap((feature) => {
        if (!feature.navigation || !feature.screen) return []
        return [
          Object.freeze({
            route: feature.navigation.value.route,
            label: feature.navigation.value.label,
            icon: feature.navigation.value.icon,
            component: feature.screen.value.component,
            order: feature.navigation.value.order,
            kind:
              feature.navigation.kind === feature.screen.kind
                ? feature.navigation.kind
                : 'legacy-pro'
          })
        ]
      })
      .sort((left, right) => (left.order ?? 100) - (right.order ?? 100))
  )
  coreSnapshot = snapshot.filter((feature) => feature.kind === 'core')
  listeners.forEach((listener) => listener())
}

function validateRoute(route: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(route)) {
    throw new Error(`Invalid feature route: ${route}`)
  }
}

function updateFeature(route: string, update: Partial<PendingFeature>): () => void {
  validateRoute(route)
  const current = pendingFeatures.get(route) ?? {}
  const next = { ...current }
  if (update.navigation && !next.navigation) next.navigation = update.navigation
  if (update.screen && !next.screen) next.screen = update.screen
  if (next.navigation === current.navigation && next.screen === current.screen) return () => {}
  pendingFeatures.set(route, next)
  publish()
  return () => {
    const registered = pendingFeatures.get(route)
    if (!registered) return
    let changed = false
    if (update.navigation?.owner === registered.navigation?.owner) {
      delete registered.navigation
      changed = true
    }
    if (update.screen?.owner === registered.screen?.owner) {
      delete registered.screen
      changed = true
    }
    if (!changed) return
    if (!registered.navigation && !registered.screen) pendingFeatures.delete(route)
    publish()
  }
}

/** Atomic registration API for package-owned core features. */
export function registerFeature(feature: RegisteredFeature): () => void {
  validateRoute(feature.route)
  if (HOST_OWNED_ROUTES.has(feature.route)) {
    throw new Error(`Feature route is owned by the host: ${feature.route}`)
  }
  if (pendingFeatures.has(feature.route)) {
    throw new Error(`Feature route is already registered: ${feature.route}`)
  }
  const owner = Symbol(feature.route)
  return updateFeature(feature.route, {
    navigation: {
      owner,
      kind: 'core',
      value: {
        route: feature.route,
        label: feature.label,
        icon: feature.icon,
        order: feature.order
      }
    },
    screen: {
      owner,
      kind: 'core',
      value: { name: feature.route, component: feature.component }
    }
  })
}

/** Compatibility adapter for packages that register navigation separately. */
export function registerFeatureNavigation(navigation: FeatureNavigation): () => void {
  return updateFeature(navigation.route, {
    navigation: { owner: Symbol(navigation.route), kind: 'legacy-pro', value: navigation }
  })
}

/** Compatibility adapter for packages that register screens separately. */
export function registerFeatureScreen(screen: FeatureScreen): () => void {
  return updateFeature(screen.name, {
    screen: { owner: Symbol(screen.name), kind: 'legacy-pro', value: screen }
  })
}

export function hasFeatureNavigation(route: string): boolean {
  return pendingFeatures.get(route)?.navigation !== undefined
}

export function getRegisteredFeature(route: string): PublishedFeature | undefined {
  return snapshot.find((feature) => feature.route === route)
}

export function getRegisteredFeatures(): readonly PublishedFeature[] {
  return snapshot
}

export function getCoreFeatures(): readonly PublishedFeature[] {
  return coreSnapshot
}

export function subscribeToFeatures(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useRegisteredFeatures(): readonly PublishedFeature[] {
  return useSyncExternalStore(subscribeToFeatures, getRegisteredFeatures, getRegisteredFeatures)
}

export function useCoreFeatures(): readonly PublishedFeature[] {
  return useSyncExternalStore(subscribeToFeatures, getCoreFeatures, getCoreFeatures)
}
