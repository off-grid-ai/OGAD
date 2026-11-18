/**
 * What a person picked in onboarding: the groups (what they want to do) and the parts (which
 * ones). The lists and rules live in @offgrid/features; this file only keeps the picks on this
 * computer, beside `onboarding_step`, so a restart resumes with the same picks and the model
 * gate can set up only what they need.
 */
import {
  DEFAULT_PICKS,
  guideTopicsFor,
  modelKindsFor,
  onboardingGroups,
  partsFor,
  type ModelKind,
  type OnboardingGroupId
} from '@offgrid/features'
import type { SetupItemKind } from '../../../../shared/setup-contract'

export const PICKS_KEY = 'onboarding_picks'
/** A screen an "Open …" in onboarding's guide asked for: the app opens it once setup is done. */
export const ONBOARDING_OPEN_KEY = 'onboarding_then_open'

export interface Picks {
  groups: OnboardingGroupId[]
  parts: string[]
}

const PLATFORM = 'desktop' as const

/** Drops picks this app does not offer, and parts whose group is not picked. */
export function cleanPicks(picks: Picks): Picks {
  const offered = new Set(onboardingGroups(PLATFORM).map((g) => g.id))
  const groups = picks.groups.filter((g) => offered.has(g))
  const parts = new Set(partsFor(groups, PLATFORM).map((p) => p.id))
  return { groups, parts: picks.parts.filter((p) => parts.has(p)) }
}

/** The saved picks, or the defaults (Chat) when there are none or they cannot be read. */
export function loadPicks(): Picks {
  try {
    const saved = JSON.parse(localStorage.getItem(PICKS_KEY) ?? 'null') as Partial<Picks> | null
    if (saved && Array.isArray(saved.groups) && Array.isArray(saved.parts)) {
      return cleanPicks({ groups: saved.groups, parts: saved.parts })
    }
  } catch {
    // An unreadable value starts from the defaults.
  }
  return { groups: [...DEFAULT_PICKS.groups], parts: [...DEFAULT_PICKS.parts] }
}

export function savePicks(picks: Picks): void {
  localStorage.setItem(PICKS_KEY, JSON.stringify(picks))
}

/** No saved picks: the model gate does what it did before onboarding asked. */
export function clearPicks(): void {
  localStorage.removeItem(PICKS_KEY)
}

/**
 * Picks or unpicks a group. A newly picked group starts with its first part picked, so the next
 * step never opens on an empty column; unpicking a group drops its parts.
 */
export function toggleGroup(picks: Picks, id: OnboardingGroupId): Picks {
  if (picks.groups.includes(id)) {
    return cleanPicks({ groups: picks.groups.filter((g) => g !== id), parts: picks.parts })
  }
  const first = partsFor([id], PLATFORM)[0]
  return cleanPicks({
    groups: [...picks.groups, id],
    parts: first && !picks.parts.includes(first.id) ? [...picks.parts, first.id] : picks.parts
  })
}

export function togglePart(picks: Picks, id: string): Picks {
  return {
    groups: picks.groups,
    parts: picks.parts.includes(id) ? picks.parts.filter((p) => p !== id) : [...picks.parts, id]
  }
}

/** Which setup row each kind of model a feature needs is. */
const SETUP_KIND: Record<ModelKind, SetupItemKind> = {
  chat: 'chat',
  vision: 'chat',
  image: 'image',
  video: 'video',
  speech: 'transcription',
  voice: 'voice'
}

/**
 * The models setup checks for what was picked: chat, plus what each picked feature needs (a Pro
 * feature only with Pro). Null when nothing was picked (skipped, or set up before onboarding
 * asked): setup checks chat alone, as it always did.
 */
export function setupKindsForPicks(pro: boolean): SetupItemKind[] | null {
  if (localStorage.getItem(PICKS_KEY) === null) return null
  const kinds = modelKindsFor(loadPicks().parts, PLATFORM, pro).map((kind) => SETUP_KIND[kind])
  return [...new Set<SetupItemKind>(['chat', ...kinds])]
}

/**
 * The screens the picks open, in pick order, each once: the guide topic each picked part shows,
 * then that topic's screen. Empty when nothing was picked, so the app looks as it always did.
 */
export function pickedViews(routeOf: (topicId: string) => string | undefined): string[] {
  if (localStorage.getItem(PICKS_KEY) === null) return []
  const routes = guideTopicsFor(loadPicks().parts, PLATFORM).map(routeOf)
  return [...new Set(routes.filter((route): route is string => Boolean(route)))]
}
