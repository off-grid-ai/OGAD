/**
 * What a person picked in onboarding: the groups (what they want to do) and the parts (which
 * ones). The lists and rules live in @offgrid/features; this file only keeps the picks on this
 * computer, beside `onboarding_step`, so a restart resumes with the same picks and the model
 * gate can set up only what they need.
 */
import {
  DEFAULT_PICKS,
  cleanPicks as cleanSharedPicks,
  guideTopicsFor,
  modelKindsFor,
  toggleGroupPick,
  togglePartAnywhere as togglePartAnywhereShared,
  togglePartPick,
  type ModelKind,
  type OnboardingGroupId
} from '@offgrid/features'
import type { SetupItemKind } from '../../../../shared/setup-contract'

export const PICKS_KEY = 'onboarding_picks'
/** A screen an "Open …" in onboarding's guide asked for: the app opens it once setup is done. */
export const ONBOARDING_OPEN_KEY = 'onboarding_then_open'
/** Set for the session that finished onboarding: optional setup screens wait until a later launch,
 *  so nothing stands between a new person and their first reply. */
export const FIRST_RUN_SESSION_KEY = 'first_run_session'

export interface Picks {
  groups: OnboardingGroupId[]
  parts: string[]
}

const PLATFORM = 'desktop' as const

/** Drops picks this app does not offer, and parts whose group is not picked. */
export const cleanPicks = (picks: Picks): Picks => cleanSharedPicks(picks, PLATFORM)

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

/** Fired on window when the picks change, so the menu follows a change made in Settings. */
export const PICKS_CHANGED_EVENT = 'offgrid:picks-changed'

export function savePicks(picks: Picks): void {
  localStorage.setItem(PICKS_KEY, JSON.stringify(picks))
  window.dispatchEvent(new Event(PICKS_CHANGED_EVENT))
}

/** No saved picks: the model gate does what it did before onboarding asked. */
export function clearPicks(): void {
  localStorage.removeItem(PICKS_KEY)
  window.dispatchEvent(new Event(PICKS_CHANGED_EVENT))
}

/** Picks or unpicks one part from Settings: a group counts as picked while any of its parts is. */
export const togglePartAnywhere = (picks: Picks, id: string): Picks =>
  togglePartAnywhereShared(picks, id, PLATFORM)

/** Picks or unpicks a group; a new group starts with its first part picked. */
export const toggleGroup = (picks: Picks, id: OnboardingGroupId): Picks =>
  toggleGroupPick(picks, id, PLATFORM)

export const togglePart = togglePartPick

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
