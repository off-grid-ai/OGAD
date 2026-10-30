import { normalizeUiActionId, scrollBucket } from '../../../shared/analytics'
import { track } from './analytics'
import { internalTabFromSubroute, isInternalTabView } from './internal-tab-route'
import { routeScroller } from './route-history'

/**
 * The renderer's usage observer: which screen is showing (with dialogs and side panels as screens
 * of their own), the time spent on each while the window is in use, how deep each screen was
 * scrolled, and which fixed-id controls were pressed.
 *
 * Every report goes to main, which sends screen views as events and counts the rest into one
 * `session_summary` (docs/ANALYTICS.md). A press is reported by its fixed id from source: a
 * `data-action`, a `data-testid` or an `aria-label`. Main drops any id that is not a string literal
 * in the app's source, so text a person typed never leaves. This is not autocapture.
 */

type Clock = () => number

const PRESSABLE =
  'button, a, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="switch"], [role="tab"], [role="option"], [data-action]'
/** How long a screen shows before its empty state and scroll room are read. */
const SETTLE_MS = 1_200

/**
 * Files dropped or pasted into the chat composer: one count per file, by its extension only.
 * Main turns the extension into a type the app opens, else `other`.
 */
export function reportChatInput(method: 'drop' | 'paste', files: Iterable<{ name: string }>): void {
  for (const file of files) {
    const extension = /\.([^./\\]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? ''
    track('chat_input', { method, extension })
  }
}

/** Video Studio's pages (pro StudioScreen): the first segment of its subroute. */
const VIDEO_PAGES = new Set(['library', 'character', 'watch', 'making', 'edit'])

/** The screen name for a route: `view`, or `view:sub` for a settings section, tab or page. */
export function usageScreenName(
  view: string,
  subroute: string | null,
  settingsSection: string | null
): string {
  if (view === 'settings' && settingsSection) return `settings:${settingsSection}`
  if (isInternalTabView(view)) return `${view}:${internalTabFromSubroute(view, subroute).id}`
  if (view === 'video') {
    const page = subroute?.split('/')[0] ?? ''
    return VIDEO_PAGES.has(page) ? `video:${page}` : 'video'
  }
  return view
}

/** The fixed id a pressed control carries, normalised, or null when it has none. */
export function actionIdOf(element: Element): string | null {
  for (const attribute of ['data-action', 'data-testid', 'aria-label']) {
    const value = element.getAttribute(attribute)
    if (value) {
      const id = normalizeUiActionId(value)
      if (id) return id
    }
  }
  return null
}

/**
 * `dialog:<id>` or `panel:<id>` for an overlay, from its node's fixed id or its label. Main keeps
 * the id only if it is a fixed one from source, so a computed label falls back to the bare kind.
 */
export function overlayScreenName(
  kind: 'dialog' | 'panel',
  source: Element | string | null
): string {
  const id =
    typeof source === 'string' ? normalizeUiActionId(source) : source ? actionIdOf(source) : null
  return id ? `${kind}:${id}`.slice(0, 48) : kind
}

class UsageTracker {
  private base = 'unknown'
  private readonly overlays: { token: number; name: string }[] = []
  private nextToken = 1
  private shown: string | null = null
  /** Time the window was in use on the shown screen, before `activeSince`. */
  private activeMs = 0
  private activeSince: number | null = null
  private scrollable = false
  private deepest = 0
  private settleTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly now: Clock,
    private readonly inUse: () => boolean
  ) {}

  current(): string {
    return this.overlays.at(-1)?.name ?? this.base
  }

  setBase(screen: string): void {
    if (screen !== this.base) {
      // Scroll depth belongs to the base screen being left; overlays never change it.
      if (this.scrollable)
        track('scroll_depth', { screen: this.base, pct: scrollBucket(this.deepest) })
      this.scrollable = false
      this.deepest = 0
      clearTimeout(this.settleTimer)
      this.settleTimer = setTimeout(() => this.settled(), SETTLE_MS)
    }
    this.base = screen
    this.publish()
  }

  /** An overlay opened over the screen. Returns its close. */
  openOverlay(name: string): () => void {
    const token = this.nextToken++
    this.overlays.push({ token, name })
    this.publish()
    let closed = false
    return () => {
      if (closed) return
      closed = true
      const index = this.overlays.findIndex((overlay) => overlay.token === token)
      if (index >= 0) this.overlays.splice(index, 1)
      this.publish()
    }
  }

  /** The window may have come into use or left it (hidden, minimised or blurred). */
  refreshInUse(): void {
    const now = this.now()
    const active = this.inUse()
    if (active && this.activeSince === null) this.activeSince = now
    if (!active && this.activeSince !== null) {
      this.activeMs += now - this.activeSince
      this.activeSince = null
    }
  }

  scrolled(target: EventTarget | null): void {
    const scroller = routeScroller()
    if (!scroller || target !== scroller || this.overlays.length) return
    const room = scroller.scrollHeight - scroller.clientHeight
    if (room <= 4) return
    this.scrollable = true
    this.deepest = Math.max(this.deepest, scroller.scrollTop / room)
  }

  /** A short while after a screen shows: whether it can scroll, and whether it is empty. */
  settled(): void {
    if (this.overlays.length) return
    const scroller = routeScroller()
    if (scroller && scroller.scrollHeight - scroller.clientHeight > 4) this.scrollable = true
    const host = document.querySelector('[data-route-host]')
    if (host?.querySelector('[data-slot="empty"]')) track('empty_state_seen', { screen: this.base })
  }

  private publish(): void {
    const next = this.current()
    if (next === this.shown) return
    const now = this.now()
    const previous = this.shown
    const spent = this.activeMs + (this.activeSince !== null ? now - this.activeSince : 0)
    this.shown = next
    this.activeMs = 0
    this.activeSince = this.inUse() ? now : null
    track('screen_viewed', {
      screen: next,
      prev_screen: previous,
      prev_ms: previous ? Math.round(spent) : 0
    })
  }
}

let tracker: UsageTracker | null = null

function windowInUse(target: Window): boolean {
  return target.document.visibilityState === 'visible' && target.document.hasFocus()
}

function tracked(): UsageTracker {
  tracker ??= new UsageTracker(
    () => performance.now(),
    () => windowInUse(window)
  )
  return tracker
}

/** The base screen changed (a view, a settings section, an internal tab, a Video Studio page). */
export function setUsageScreen(screen: string): void {
  tracked().setBase(screen)
}

/** A dialog or side panel opened. Returns its close. */
export function openUsageOverlay(name: string): () => void {
  return tracked().openOverlay(name)
}

/** The screen showing now, for a press. */
export function currentUsageScreen(): string {
  return tracked().current()
}

/**
 * The page's listeners: one capture-phase click listener for presses, one passive scroll listener
 * for depth, and the window's visibility and focus for time on screen. Returns the uninstall.
 */
export function installUsageTracking(target: Window = window): () => void {
  const usage = tracked()
  const onClick = (event: MouseEvent): void => {
    const clicked = event.target
    const element = clicked instanceof Element ? clicked.closest(PRESSABLE) : null
    if (!element) return
    const action = actionIdOf(element)
    if (action) track('ui_action', { screen: usage.current(), action })
  }
  const onScroll = (event: Event): void => usage.scrolled(event.target)
  const onActivity = (): void => usage.refreshInUse()
  target.document.addEventListener('click', onClick, true)
  target.document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  target.document.addEventListener('visibilitychange', onActivity)
  target.addEventListener('focus', onActivity)
  target.addEventListener('blur', onActivity)
  onActivity()
  return () => {
    target.document.removeEventListener('click', onClick, true)
    target.document.removeEventListener('scroll', onScroll, { capture: true })
    target.document.removeEventListener('visibilitychange', onActivity)
    target.removeEventListener('focus', onActivity)
    target.removeEventListener('blur', onActivity)
  }
}

/** For tests: start over with a given clock and in-use reading. */
export function resetUsageTrackingForTests(now?: Clock, active?: () => boolean): void {
  tracker = now ? new UsageTracker(now, active ?? (() => true)) : null
}
