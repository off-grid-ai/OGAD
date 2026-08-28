import { modelKindLabel } from './model-kind-labels'

export const INTERNAL_TAB_VIEWS = ['devices', 'entities', 'models', 'notifications'] as const
export type InternalTabView = (typeof INTERNAL_TAB_VIEWS)[number]

export interface InternalTabRoute {
  id: string
  /** The default tab has no URL suffix. */
  slug: string | null
  label: string
  /** Only this tab may keep screen-owned detail segments after its tab slug. */
  nested?: boolean
}

const ROUTES: Record<InternalTabView, readonly InternalTabRoute[]> = {
  devices: [
    { id: 'devices', slug: null, label: 'Devices' },
    { id: 'sharing', slug: 'sharing', label: 'Sync sharing' },
    { id: 'activity', slug: 'activity', label: 'Activity', nested: true },
    { id: 'files', slug: 'files', label: 'Files', nested: true }
  ],
  entities: [
    { id: 'all', slug: null, label: 'All' },
    { id: 'projects', slug: 'projects', label: 'Projects' },
    { id: 'people', slug: 'people', label: 'People' },
    { id: 'companies', slug: 'companies', label: 'Companies' },
    { id: 'topics', slug: 'topics', label: 'Topics' },
    { id: 'places', slug: 'places', label: 'Places' },
    { id: 'objects', slug: 'objects', label: 'Objects' }
  ],
  models: [
    { id: 'text', slug: null, label: modelKindLabel('text') },
    { id: 'image', slug: 'image', label: modelKindLabel('image') },
    { id: 'computer_use', slug: 'computer-use', label: modelKindLabel('computer_use') },
    { id: 'voice', slug: 'voice', label: modelKindLabel('voice') },
    { id: 'transcription', slug: 'transcription', label: modelKindLabel('transcription') },
    { id: 'storage', slug: 'storage', label: 'Storage' }
  ],
  notifications: [
    { id: 'all', slug: null, label: 'All' },
    { id: 'sharing', slug: 'sharing', label: 'Sharing' }
  ]
}

export function isInternalTabView(view: string): view is InternalTabView {
  return INTERNAL_TAB_VIEWS.includes(view as InternalTabView)
}

export function internalTabRoutes(view: InternalTabView): readonly InternalTabRoute[] {
  return ROUTES[view]
}

export function internalTabRoute(view: InternalTabView, id: string): InternalTabRoute {
  return ROUTES[view].find((route) => route.id === id) ?? ROUTES[view][0]!
}

export function internalTabFromSubroute(
  view: InternalTabView,
  subroute: string | null
): InternalTabRoute {
  if (!subroute) return ROUTES[view][0]!
  const slug = subroute.split('/')[0]
  return ROUTES[view].find((route) => route.slug === slug) ?? ROUTES[view][0]!
}

export function internalTabSubroute(view: InternalTabView, id: string): string | null {
  return internalTabRoute(view, id).slug
}

/** Reject unknown tabs and screen-owned detail segments under tabs that do not allow them. */
export function canonicalInternalTabSubroute(
  view: InternalTabView,
  subroute: string | null
): string | null {
  if (!subroute) return null
  const route = internalTabFromSubroute(view, subroute)
  if (!route.slug) return null
  if (subroute === route.slug) return route.slug
  return route.nested && subroute.startsWith(`${route.slug}/`) ? subroute : null
}

export function internalTabPath(view: InternalTabView, subroute: string | null): string {
  const canonical = canonicalInternalTabSubroute(view, subroute)
  return canonical ? `/${view}/${encodeURIComponent(canonical)}` : `/${view}`
}

export function internalTabLocation(
  pathname: string
): { view: InternalTabView; subroute: string | null } | null {
  const [, candidateView, encodedSubroute] = pathname.split('/', 3)
  if (!candidateView || !isInternalTabView(candidateView)) return null
  if (!encodedSubroute) return { view: candidateView, subroute: null }
  try {
    return {
      view: candidateView,
      subroute: canonicalInternalTabSubroute(candidateView, decodeURIComponent(encodedSubroute))
    }
  } catch {
    return { view: candidateView, subroute: null }
  }
}
