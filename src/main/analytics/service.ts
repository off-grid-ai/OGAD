import {
  ANALYTICS_SETTING_KEYS,
  ANALYTICS_SETTING_KEY_LIST,
  CHAT_INPUT_METHODS,
  ERROR_RESPONSES,
  FAILURE_PROMPT_INTERVAL_DAYS,
  FEATURES,
  FLOW_STEPS,
  MESSAGE_ACTIONS,
  NOTIFICATION_TYPES,
  OPT_IN_SOURCES,
  PALETTE_COMMANDS,
  SCROLL_BUCKETS,
  SHORTCUTS,
  THEME_MODES,
  UI_ACTION_ID,
  type ScrollBucket,
  type AnalyticsConsent,
  type AnalyticsFlow,
  type AnalyticsPromptKind,
  type FlowOutcome,
  type OptInSource,
  type RendererErrorReport
} from '../../shared/analytics'
import type { AnalyticsClient, ClientOptions } from './client'
import type { AnalyticsProperties, AnalyticsValue } from './properties'
import { documentFileType, roundMs } from './properties'
import { scrubException } from './scrub'
import { SessionTally, type SummaryCounter } from './session-tally'
import type { InflightWork, UncleanExitMarker } from './unclean-exit'

export interface AnalyticsSettings {
  get<T>(key: string, defaultValue: T): T
  set(key: string, value: unknown): void
  delete(key: string): void
}

export interface AnalyticsServiceDeps {
  settings: AnalyticsSettings
  createClient: (options: ClientOptions) => AnalyticsClient
  apiKey: string
  host: string
  /** False for a debug (unpackaged) build: the client is never created there. */
  buildAllowed: boolean
  /** The properties on every event (docs/ANALYTICS.md). Read at each capture, so `pro` stays current. */
  superProperties: () => AnalyticsProperties
  marker: UncleanExitMarker
  now?: () => number
  randomId?: () => string
  onConsentChanged?: (consent: AnalyticsConsent) => void
  onPrompt?: (kind: AnalyticsPromptKind) => void
  /**
   * The `ui_action` ids main accepts: the fixed ids found in source at build time. Defaults to the
   * build's list; an id outside it is dropped, so visible or user text never passes.
   */
  uiActionIds?: ReadonlySet<string>
  /** When this launch started, for `first_message`. */
  launchedAt?: number
  /**
   * Read once, at this launch's first message: whether it is the install's first message ever, and
   * when the install was first used (null when unknown).
   */
  firstMessageInfo?: () => { firstEver: boolean; installedAt: number | null }
}

function buildUiActionIds(): ReadonlySet<string> {
  return new Set(typeof __OFFGRID_UI_ACTION_IDS__ === 'undefined' ? [] : __OFFGRID_UI_ACTION_IDS__)
}

const DAY_MS = 86_400_000
/** The open session's counters are written at most this often, so a crash loses little. */
const PERSIST_EVERY_MS = 10_000
/** A feature counts at most once in this window: speech plays sentence by sentence, tools loop. */
const FEATURE_USE_WINDOW_MS = 10 * 60 * 1000
const SCREEN_NAME = /^[a-z0-9][a-z0-9:_-]{0,47}$/
const ERROR_CODE = /^[a-z0-9_]{1,40}$/
const CATALOG_OR_CUSTOM = /^(custom|[A-Za-z0-9][\w.-]{0,63}(?:\/[\w.-]{1,96})?)$/

type CrashEvent = '$exception' | 'unclean_exit' | 'llama_server_crashed'

interface CountInput {
  props: Record<string, unknown>
  str: (key: string) => string
  oneOf: (list: readonly string[], key: string) => string | null
}

/**
 * The one owner of opt-in analytics: consent, the anonymous ID, the PostHog client, consent
 * prompts and flows. Nothing else imports PostHog.
 *
 * Off by default. The client is created only after the user opts in, only in a packaged build
 * with a project key, and it is discarded (queue dropped, ID reset) on opt-out.
 */
export class AnalyticsService {
  private client: AnalyticsClient | null = null
  private readonly flows = new Map<AnalyticsFlow, { startedAt: number; lastStep?: string }>()
  private onboardingSteps: readonly string[] | null = null
  private promptedThisSession = false
  private readonly featureUsedAt = new Map<string, number>()
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly uiActionIds: ReadonlySet<string>
  private readonly launchedAt: number
  private session: SessionTally | null = null
  private sessionsEnded = 0
  private persistedAt = 0
  private firstMessageSent = false
  private appearanceState: Record<string, AnalyticsValue> | null = null

  constructor(private readonly deps: AnalyticsServiceDeps) {
    this.now = deps.now ?? Date.now
    this.randomId = deps.randomId ?? (() => crypto.randomUUID())
    this.uiActionIds = deps.uiActionIds ?? buildUiActionIds()
    this.launchedAt = deps.launchedAt ?? this.now()
  }

  // --- consent ------------------------------------------------------------------------------

  consent(): AnalyticsConsent {
    const read = <T>(key: string, fallback: T): T => {
      try {
        return this.deps.settings.get<T>(key, fallback)
      } catch {
        return fallback
      }
    }
    const lastPromptAt = read<unknown>(ANALYTICS_SETTING_KEYS.lastPromptAt, null)
    return {
      usage: read<unknown>(ANALYTICS_SETTING_KEYS.usage, false) === true,
      crashes: read<unknown>(ANALYTICS_SETTING_KEYS.crashes, false) === true,
      asked: read<unknown>(ANALYTICS_SETTING_KEYS.asked, false) === true,
      lastPromptAt: typeof lastPromptAt === 'number' ? lastPromptAt : null
    }
  }

  /** Start the client when the user already opted in on an earlier launch. */
  start(): void {
    const consent = this.consent()
    if (!(consent.usage || consent.crashes)) return
    if (this.client || !this.deps.buildAllowed || !this.deps.apiKey) return
    this.client = this.deps.createClient({ apiKey: this.deps.apiKey, host: this.deps.host })
  }

  /** Change one or both toggles. Turning usage on reports where the user opted in. */
  setConsent(patch: { usage?: boolean; crashes?: boolean }, source: OptInSource): AnalyticsConsent {
    const before = this.consent()
    const next = {
      usage: typeof patch.usage === 'boolean' ? patch.usage : before.usage,
      crashes: typeof patch.crashes === 'boolean' ? patch.crashes : before.crashes
    }
    this.deps.settings.set(ANALYTICS_SETTING_KEYS.usage, next.usage)
    this.deps.settings.set(ANALYTICS_SETTING_KEYS.crashes, next.crashes)
    this.deps.settings.set(ANALYTICS_SETTING_KEYS.asked, true)
    if (source !== 'settings')
      this.deps.settings.set(ANALYTICS_SETTING_KEYS.lastPromptAt, this.now())
    if (!next.usage && !next.crashes) {
      void this.discard()
    } else {
      this.start()
      if (next.usage && !before.usage) {
        this.capture('analytics_opted_in', { source })
        if (source === 'setup') this.beginOnboardingFlow()
      }
    }
    return this.publish()
  }

  /** Turn both toggles on (the setup checkbox and the two prompts). */
  optIn(source: OptInSource): AnalyticsConsent {
    return this.setConsent({ usage: true, crashes: true }, source)
  }

  /** The user saw a consent choice and did not opt in. */
  dismissPrompt(): AnalyticsConsent {
    this.deps.settings.set(ANALYTICS_SETTING_KEYS.asked, true)
    this.deps.settings.set(ANALYTICS_SETTING_KEYS.lastPromptAt, this.now())
    return this.publish()
  }

  /** Delete-all-data: opt out and forget every analytics setting on this device. */
  forget(): void {
    void this.discard()
    for (const key of ANALYTICS_SETTING_KEY_LIST) {
      try {
        this.deps.settings.delete(key)
      } catch {
        /* the settings table is being cleared anyway */
      }
    }
    this.publish()
  }

  private async discard(): Promise<void> {
    const client = this.client
    this.client = null
    this.flows.clear()
    this.onboardingSteps = null
    this.session = null
    try {
      this.deps.settings.delete(ANALYTICS_SETTING_KEYS.pendingSession)
    } catch {
      /* best effort */
    }
    try {
      this.deps.settings.delete(ANALYTICS_SETTING_KEYS.installId)
    } catch {
      /* best effort */
    }
    await client?.discard()
  }

  private publish(): AnalyticsConsent {
    const consent = this.consent()
    this.deps.onConsentChanged?.(consent)
    return consent
  }

  // --- capture ------------------------------------------------------------------------------

  private installId(): string {
    const stored = this.deps.settings.get<unknown>(ANALYTICS_SETTING_KEYS.installId, null)
    if (typeof stored === 'string' && stored) return stored
    const id = this.randomId()
    this.deps.settings.set(ANALYTICS_SETTING_KEYS.installId, id)
    return id
  }

  private usageOn(): boolean {
    return this.client !== null && this.consent().usage
  }

  private send(event: string, properties: Record<string, unknown>): void {
    const client = this.client
    if (!client) return
    try {
      client.capture(this.installId(), event, {
        ...properties,
        ...this.deps.superProperties(),
        // Anonymous events only: no person profile is created for the install ID.
        $process_person_profile: false
      } as AnalyticsProperties)
    } catch {
      /* Analytics must never break the feature it observes. */
    }
  }

  /** A usage event. Sent only while Anonymous stats is on. */
  capture(event: string, properties: Record<string, AnalyticsValue | undefined> = {}): void {
    if (!this.client || !this.consent().usage) return
    if (event === 'feature_used' && this.recentlyUsed(String(properties.feature))) return
    this.send(event, withoutUndefined(properties))
    this.observeForFlows(event)
    if (event === 'screen_viewed' && typeof properties.screen === 'string')
      this.session?.screenViewed(properties.screen, this.now())
    if (event === 'message_sent') this.noteFirstMessage()
  }

  /** `first_message`: once per launch, the time from launch, and from install for the first ever. */
  private noteFirstMessage(): void {
    if (this.firstMessageSent) return
    this.firstMessageSent = true
    const now = this.now()
    let firstEver = false
    let sinceInstall: number | null = null
    try {
      const info = this.deps.firstMessageInfo?.()
      firstEver = info?.firstEver === true
      if (firstEver && info?.installedAt != null && info.installedAt <= now)
        sinceInstall = roundMs(now - info.installedAt)
    } catch {
      /* unknown stays false and null */
    }
    this.send('first_message', {
      since_launch_ms: roundMs(now - this.launchedAt),
      first_ever: firstEver,
      since_install_ms: sinceInstall
    })
  }

  private recentlyUsed(feature: string): boolean {
    const now = this.now()
    const last = this.featureUsedAt.get(feature)
    if (last !== undefined && now - last < FEATURE_USE_WINDOW_MS) return true
    this.featureUsedAt.set(feature, now)
    return false
  }

  /** A crash event. Sent only while Crash reports is on. */
  captureCrash(event: CrashEvent, properties: Record<string, unknown>): void {
    if (!this.client || !this.consent().crashes) return
    this.send(event, properties)
  }

  /** A scrubbed `$exception`. `process` says which process threw: main, renderer or a child. */
  captureException(error: unknown, context: { process: string; handled: boolean }): void {
    if (!this.client || !this.consent().crashes) return
    const scrubbed = scrubException(error)
    this.captureCrash('$exception', {
      $exception_level: 'error',
      $exception_list: [
        {
          type: scrubbed.type,
          value: scrubbed.value,
          mechanism: { handled: context.handled, synthetic: false, type: 'generic' },
          // Oldest call first, as PostHog renders frames.
          stacktrace: { type: 'raw', frames: [...scrubbed.frames].reverse() }
        }
      ],
      process: context.process
    })
  }

  captureRendererError(report: unknown): void {
    if (!report || typeof report !== 'object') return
    const { name, message, stack } = report as RendererErrorReport
    this.captureException(
      { name: typeof name === 'string' ? name : 'Error', message, stack },
      { process: 'renderer', handled: false }
    )
  }

  /** A report from the renderer, accepted only for the events and properties it may send. */
  captureFromRenderer(event: unknown, properties: unknown): void {
    const props = (properties && typeof properties === 'object' ? properties : {}) as Record<
      string,
      unknown
    >
    const bool = (key: string): boolean => props[key] === true
    switch (event) {
      case 'screen_viewed': {
        const screen = this.screenName(props.screen)
        if (!screen) return
        const prevMs = typeof props.prev_ms === 'number' ? props.prev_ms : 0
        this.capture('screen_viewed', {
          screen,
          prev_screen: this.screenName(props.prev_screen),
          prev_ms: roundMs(prevMs)
        })
        return
      }
      case 'message_sent':
        this.capture('message_sent', {
          has_image: bool('has_image'),
          has_document: bool('has_document'),
          tools_enabled: bool('tools_enabled')
        })
        return
      case 'reply_regenerated':
      case 'problem_reported':
        this.capture(event)
        return
      case 'feature_used':
        if ((FEATURES as readonly unknown[]).includes(props.feature)) {
          this.capture('feature_used', { feature: props.feature as string })
        }
        return
      case 'message_action':
        if ((MESSAGE_ACTIONS as readonly unknown[]).includes(props.action))
          this.capture('message_action', { action: props.action as string })
        return
      default:
        this.countFromRenderer(event, props)
        return
    }
  }

  /**
   * A screen name the renderer reported: a view, `view:sub`, or an overlay. A dialog or panel keeps
   * its id only when the id is a fixed one from source (a computed label can carry a name).
   */
  private screenName(value: unknown): string | null {
    if (typeof value !== 'string' || !SCREEN_NAME.test(value)) return null
    const overlay = /^(dialog|panel):(.+)$/.exec(value)
    if (overlay) return this.uiActionIds.has(overlay[2]!) ? value : overlay[1]!
    return value
  }

  /** Renderer interactions that are counted into `session_summary`, never sent one by one. */
  private countFromRenderer(event: unknown, props: Record<string, unknown>): void {
    const handle = typeof event === 'string' ? this.counted[event] : undefined
    if (!handle || !Object.hasOwn(this.counted, event as string)) return
    const str = (key: string): string => (typeof props[key] === 'string' ? props[key] : '')
    const oneOf = (list: readonly string[], key: string): string | null =>
      list.includes(str(key)) ? str(key) : null
    handle({ props, str, oneOf })
  }

  /** One handler per counted renderer event: validate, then count under a fixed key. */
  private readonly counted: Record<string, (input: CountInput) => void> = {
    ui_action: ({ props, str }) => {
      const action = str('action')
      const screen = this.screenName(props.screen)?.split(':')[0]
      if (!screen || !UI_ACTION_ID.test(action) || !this.uiActionIds.has(action)) return
      this.countInteraction('actions', `${screen}:${action}`)
    },
    scroll_depth: ({ props }) => {
      const screen = this.screenName(props.screen)
      if (!screen || !(SCROLL_BUCKETS as readonly unknown[]).includes(props.pct)) return
      if (!this.usageOn()) return
      this.session?.scrolled(screen, props.pct as ScrollBucket, this.now())
      this.persistSoon()
    },
    shortcut_used: ({ oneOf }) => {
      const shortcut = oneOf(SHORTCUTS, 'shortcut')
      if (shortcut) this.countInteraction('shortcuts', shortcut)
    },
    command_used: ({ props, oneOf }) => {
      const command = oneOf(PALETTE_COMMANDS, 'command')
      if (!command) return
      const target = command === 'go_to' ? this.screenName(props.target) : null
      this.countInteraction('commands', target ? `${command}:${target}` : command)
    },
    error_shown: ({ str }) => {
      if (ERROR_CODE.test(str('error_code')))
        this.countInteraction('errors_shown', str('error_code'))
    },
    error_response: ({ str, oneOf }) => {
      const response = oneOf(ERROR_RESPONSES, 'response')
      if (ERROR_CODE.test(str('error_code')) && response)
        this.countInteraction('error_responses', `${str('error_code')}:${response}`)
    },
    empty_state_seen: ({ props }) => {
      const screen = this.screenName(props.screen)
      if (screen) this.countInteraction('empty_states', screen)
    },
    notification_clicked: ({ oneOf }) => {
      const type = oneOf(NOTIFICATION_TYPES, 'type')
      if (type) this.countInteraction('notifications_clicked', type)
    },
    chat_input: ({ str, oneOf }) => {
      const method = oneOf(CHAT_INPUT_METHODS, 'method')
      if (!method) return
      // The extension maps to a type the app opens, else `other`: a private suffix never passes.
      const extension = str('extension').slice(0, 16)
      const type = documentFileType(extension ? `file.${extension}` : 'file')
      this.countInteraction('chat_inputs', `${method}:${type}`)
    },
    appearance: ({ props, oneOf }) => {
      const theme = oneOf(THEME_MODES, 'theme')
      if (!theme || typeof props.ui_animations !== 'boolean') return
      this.appearanceState = { theme, ui_animations: props.ui_animations }
    }
  }

  /** Count one interaction into the open session. Only while Anonymous stats is on. */
  countInteraction(counter: SummaryCounter, key: string): void {
    if (!this.session || !this.usageOn()) return
    this.session.count(counter, key, this.now())
    this.persistSoon()
  }

  /** The appearance the renderer last reported, for the daily snapshot. */
  appearance(): Record<string, AnalyticsValue> {
    return this.appearanceState ?? {}
  }

  // --- prompts ------------------------------------------------------------------------------

  /** A model download or load, the chat engine or a generation failed. Ask once a month. */
  noteFailure(): void {
    const consent = this.consent()
    if (consent.usage || consent.crashes || this.promptedThisSession) return
    const interval = FAILURE_PROMPT_INTERVAL_DAYS * DAY_MS
    if (consent.lastPromptAt !== null && this.now() - consent.lastPromptAt < interval) return
    this.prompt('failure')
  }

  /** A reply finished. Someone who was never asked (they set up before this version) is asked once. */
  noteSuccessfulReply(): void {
    const consent = this.consent()
    if (consent.asked || consent.usage || consent.crashes || this.promptedThisSession) return
    this.prompt('first_chat')
  }

  private prompt(kind: AnalyticsPromptKind): void {
    if (!this.deps.onPrompt) return
    this.promptedThisSession = true
    this.deps.settings.set(ANALYTICS_SETTING_KEYS.asked, true)
    this.deps.settings.set(ANALYTICS_SETTING_KEYS.lastPromptAt, this.now())
    this.deps.onPrompt(kind)
  }

  // --- flows --------------------------------------------------------------------------------

  /** A flow report from either process. Unknown flows, steps and codes are ignored. */
  flow(report: unknown): void {
    if (!report || typeof report !== 'object') return
    const { flow, action } = report as { flow?: unknown; action?: unknown }
    if (typeof flow !== 'string' || !(flow in FLOW_STEPS)) return
    const name = flow as AnalyticsFlow
    if (action === 'start') return this.startFlow(name)
    if (action === 'step') {
      const { step, detail } = report as { step?: unknown; detail?: unknown }
      if (typeof step !== 'string' || !(FLOW_STEPS[name] as readonly string[]).includes(step))
        return
      return this.stepFlow(name, step, typeof detail === 'string' ? detail : undefined)
    }
    if (action === 'finish') {
      const { outcome, errorCode } = report as { outcome?: unknown; errorCode?: unknown }
      if (outcome !== 'done' && outcome !== 'failed' && outcome !== 'cancelled') return
      return this.finishFlow(name, outcome, typeof errorCode === 'string' ? errorCode : undefined)
    }
  }

  private startFlow(flow: AnalyticsFlow): void {
    this.flows.set(flow, { startedAt: this.now() })
    this.capture('flow_started', { flow })
  }

  private stepFlow(flow: AnalyticsFlow, step: string, detail?: string): void {
    if (!this.flows.has(flow)) this.startFlow(flow)
    const state = this.flows.get(flow)
    if (state) state.lastStep = step
    const extra: AnalyticsProperties = {}
    if (detail !== undefined && CATALOG_OR_CUSTOM.test(detail)) {
      if (flow === 'pro_upgrade') extra.feature = detail
      if (flow === 'connector_add') extra.connector = detail
    }
    // A film's final render: now, or tonight while the Mac is idle.
    if (flow === 'video_story' && (detail === 'now' || detail === 'tonight')) extra.detail = detail
    this.capture('flow_step', { flow, step, ...extra })
  }

  private finishFlow(flow: AnalyticsFlow, outcome: FlowOutcome, errorCode?: string): void {
    const state = this.flows.get(flow)
    this.flows.delete(flow)
    if (flow === 'onboarding') this.onboardingSteps = null
    this.capture('flow_finished', {
      flow,
      outcome,
      duration_ms: state ? roundMs(this.now() - state.startedAt) : 0,
      failed_step: outcome === 'done' ? null : (state?.lastStep ?? null),
      error_code: errorCode && ERROR_CODE.test(errorCode) ? errorCode : null
    })
  }

  /**
   * The onboarding funnel starts when someone opts in on the setup screen and follows their first
   * download, load and message in this session.
   */
  private beginOnboardingFlow(): void {
    this.startFlow('onboarding')
    this.stepFlow('onboarding', 'setup_shown')
    this.onboardingSteps = FLOW_STEPS.onboarding.slice(1)
  }

  private observeForFlows(event: string): void {
    const remaining = this.onboardingSteps
    if (!remaining?.length) return
    const step =
      event === 'model_download_started'
        ? 'download_started'
        : event === 'model_download_finished'
          ? 'download_done'
          : event === 'model_loaded'
            ? 'model_loaded'
            : event === 'message_sent'
              ? 'first_message'
              : null
    if (!step || !remaining.includes(step)) return
    this.onboardingSteps = remaining.slice(remaining.indexOf(step) + 1)
    this.stepFlow('onboarding', step)
    if (step === 'first_message') this.finishFlow('onboarding', 'done')
  }

  // --- in-flight work -----------------------------------------------------------------------

  /** Mark a load or generation as in flight for `unclean_exit`. Returns the end callback. */
  beginWork(work: InflightWork): () => void {
    if (!this.client || !this.consent().crashes) return () => {}
    return this.deps.marker.begin(work)
  }

  setForeground(foreground: boolean): void {
    this.deps.marker.setForeground(foreground)
  }

  /** On launch: report the previous launch's death in the foreground, if it qualifies. */
  async reportPreviousExit(): Promise<void> {
    const properties = await this.deps.marker.takePrevious()
    if (properties) this.captureCrash('unclean_exit', properties)
  }

  // --- daily snapshot -----------------------------------------------------------------------

  /**
   * Send `features_snapshot`, and `usage_snapshot` when given its reader, at most once a calendar
   * day. Returns true when they were sent.
   */
  async snapshotFeatures(
    read: () => Promise<Record<string, boolean>>,
    readUsage?: () => Promise<AnalyticsProperties>
  ): Promise<boolean> {
    if (!this.client || !this.consent().usage) return false
    const day = new Date(this.now()).toISOString().slice(0, 10)
    if (this.deps.settings.get<unknown>(ANALYTICS_SETTING_KEYS.snapshotDay, null) === day)
      return false
    const features = await read()
    const usage = readUsage ? await readUsage() : null
    this.deps.settings.set(ANALYTICS_SETTING_KEYS.snapshotDay, day)
    this.capture('features_snapshot', features)
    if (usage) this.capture('usage_snapshot', usage)
    return true
  }

  // --- sessions -----------------------------------------------------------------------------

  /**
   * One of the app's windows took focus. Starts a session, or resumes the open one. A session that
   * starts after an earlier one ended in this launch sends `app_opened` (resumed), so every
   * `app_backgrounded` has its opening.
   */
  sessionFocused(): void {
    const now = this.now()
    if (this.session) {
      this.session.foreground(now)
      return
    }
    this.session = SessionTally.start(now)
    if (this.sessionsEnded > 0) this.capture('app_opened', { cold_start_ms: null, resumed: true })
  }

  /** No window of the app has focus. The session stays open until `endSession`. */
  sessionBlurred(): void {
    if (!this.session) return
    this.session.background(this.now())
    this.persist()
  }

  /** Close the open session: `app_backgrounded` and `session_summary`, then forget its counters. */
  endSession(): void {
    const session = this.session
    if (!session) return
    this.session = null
    this.sessionsEnded += 1
    const now = this.now()
    session.background(now)
    if (this.usageOn()) {
      const summary = session.summary(now)
      this.capture('app_backgrounded', { session_ms: summary.session_ms as number })
      this.send('session_summary', summary)
    }
    this.forgetPending()
  }

  /** On launch: a session the previous launch never closed (it crashed) is reported now. */
  reportPreviousSession(): void {
    let raw: unknown = null
    try {
      raw = this.deps.settings.get<unknown>(ANALYTICS_SETTING_KEYS.pendingSession, null)
    } catch {
      return
    }
    if (raw === null) return
    this.forgetPending()
    const previous = SessionTally.restore(raw)
    if (!previous || !this.usageOn()) return
    this.send('session_summary', { ...previous.summary(previous.state.lastAt), recovered: true })
  }

  private persistSoon(): void {
    if (this.now() - this.persistedAt >= PERSIST_EVERY_MS) this.persist()
  }

  private persist(): void {
    if (!this.session || !this.usageOn()) return
    this.persistedAt = this.now()
    try {
      this.deps.settings.set(ANALYTICS_SETTING_KEYS.pendingSession, this.session.toJSON())
    } catch {
      /* the counters still go at the session's end */
    }
  }

  private forgetPending(): void {
    try {
      this.deps.settings.delete(ANALYTICS_SETTING_KEYS.pendingSession)
    } catch {
      /* best effort */
    }
  }

  // --- lifecycle ----------------------------------------------------------------------------

  flush(): Promise<void> {
    return this.client?.flush() ?? Promise.resolve()
  }

  /** A clean quit: the session closes, nothing in flight crashed, and what is queued is sent. */
  async shutdown(): Promise<void> {
    this.endSession()
    await this.deps.marker.clear()
    const client = this.client
    this.client = null
    await client?.shutdown()
  }

  /** True while a client exists (the user opted in and this build may send). */
  get active(): boolean {
    return this.client !== null
  }
}

function withoutUndefined(
  properties: Record<string, AnalyticsValue | undefined>
): AnalyticsProperties {
  const result: Record<string, AnalyticsValue> = {}
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

export function isOptInSource(value: unknown): value is OptInSource {
  return (OPT_IN_SOURCES as readonly unknown[]).includes(value)
}
