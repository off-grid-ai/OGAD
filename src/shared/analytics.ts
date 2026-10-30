/**
 * The opt-in analytics contract shared by main, preload and the renderer.
 *
 * docs/ANALYTICS.md is the specification. This file holds only the values both sides of the IPC
 * bridge must agree on: the consent shape, the settings keys, the channels and the events and
 * flows the renderer is allowed to report. Main validates every renderer report against these
 * lists, so the renderer can never widen what is sent.
 */

export const ANALYTICS_SETTING_KEYS = {
  usage: 'analyticsUsage',
  crashes: 'analyticsCrashes',
  asked: 'analyticsAsked',
  lastPromptAt: 'analyticsLastPromptAt',
  installId: 'analyticsInstallId',
  /** The day the last daily `features_snapshot` went, so a relaunch does not send another. */
  snapshotDay: 'analyticsSnapshotDay',
  /** The open session's counters, so a crash still reports them on the next launch. */
  pendingSession: 'analyticsPendingSession'
} as const

export type AnalyticsSettingKey =
  (typeof ANALYTICS_SETTING_KEYS)[keyof typeof ANALYTICS_SETTING_KEYS]

export const ANALYTICS_SETTING_KEY_LIST: readonly AnalyticsSettingKey[] =
  Object.values(ANALYTICS_SETTING_KEYS)

export function isAnalyticsSettingKey(key: string): key is AnalyticsSettingKey {
  return (ANALYTICS_SETTING_KEY_LIST as readonly string[]).includes(key)
}

/** What the user chose on this device. Off until they turn it on. */
export interface AnalyticsConsent {
  usage: boolean
  crashes: boolean
  /** The user saw a consent choice (the setup checkbox or a prompt). */
  asked: boolean
  /** When a prompt last asked, in epoch ms. */
  lastPromptAt: number | null
}

export const ANALYTICS_CONSENT_OFF: AnalyticsConsent = {
  usage: false,
  crashes: false,
  asked: false,
  lastPromptAt: null
}

export const OPT_IN_SOURCES = ['setup', 'settings', 'failure_prompt', 'first_chat_prompt'] as const
export type OptInSource = (typeof OPT_IN_SOURCES)[number]

/** Which consent prompt main asks the renderer to show. */
export type AnalyticsPromptKind = 'failure' | 'first_chat'

export const ANALYTICS_CHANNELS = {
  consentSync: 'analytics:consent-sync',
  consentChanged: 'analytics:consent-changed',
  setConsent: 'analytics:set-consent',
  optIn: 'analytics:opt-in',
  dismissPrompt: 'analytics:dismiss-prompt',
  prompt: 'analytics:prompt',
  capture: 'analytics:capture',
  flow: 'analytics:flow',
  rendererError: 'analytics:renderer-error',
  readLog: 'analytics:read-log',
  emailLog: 'analytics:email-log',
  revealLog: 'analytics:reveal-log'
} as const

export const FEATURES = [
  'voice_input',
  'tts',
  'image_generation',
  'video_generation',
  'vision',
  'web_search',
  'tools',
  'mcp_tool',
  'remote_server',
  'browser_action',
  'clipboard',
  'meetings',
  'sync'
] as const
export type AnalyticsFeature = (typeof FEATURES)[number]

export const FLOW_STEPS = {
  onboarding: ['setup_shown', 'download_started', 'download_done', 'model_loaded', 'first_message'],
  model_transfer: ['opened', 'device_picked', 'model_picked', 'started'],
  sync_pairing: ['opened', 'code_shown', 'code_entered', 'paired'],
  remote_server: ['opened', 'address_entered', 'tested', 'connected'],
  voice_setup: ['opened', 'model_picked', 'downloaded'],
  image_setup: ['opened', 'model_picked', 'downloaded'],
  video_setup: ['opened', 'model_picked', 'downloaded'],
  video_story: [
    'storyboard_shown',
    'draft_started',
    'draft_finished',
    'final_started',
    'final_finished',
    'exported'
  ],
  connector_add: ['opened', 'connector_picked', 'authorised'],
  pro_upgrade: ['gate_shown', 'paywall_viewed', 'trial_started', 'purchased']
} as const
export type AnalyticsFlow = keyof typeof FLOW_STEPS
export type FlowStep<F extends AnalyticsFlow = AnalyticsFlow> = (typeof FLOW_STEPS)[F][number]
export type FlowOutcome = 'done' | 'failed' | 'cancelled'

/** One flow report from the renderer. Main owns the timing. */
export type FlowReport =
  | { flow: AnalyticsFlow; action: 'start' }
  | {
      flow: AnalyticsFlow
      action: 'step'
      step: string
      /** `pro_upgrade` gate_shown: which Pro feature. `connector_add` connector_picked: catalog id or `custom`. */
      detail?: string
    }
  | { flow: AnalyticsFlow; action: 'finish'; outcome: FlowOutcome; errorCode?: string }

/**
 * A `ui_action` id: a `data-action`, a `data-testid` or a fixed `aria-label`, normalised. Main
 * accepts only ids collected from source at build time (scripts/config/ui-action-ids.ts), so no
 * visible or user text can pass, whatever the renderer sends.
 */
export const UI_ACTION_ID = /^[a-z0-9][a-z0-9:_-]{0,63}$/

/** `Close panel` → `close-panel`. Null when nothing usable is left. */
export function normalizeUiActionId(raw: string): string | null {
  const id = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '-')
    .replace(/^[-:_]+|[-:_]+$/g, '')
    .slice(0, 64)
    .replace(/[-:_]+$/, '')
  return UI_ACTION_ID.test(id) ? id : null
}

/** The deepest point reached on a screen, in quarters. */
export const SCROLL_BUCKETS = [0, 25, 50, 75, 100] as const
export type ScrollBucket = (typeof SCROLL_BUCKETS)[number]

/** A scroll fraction (0..1) rounded down to its quarter; the very bottom counts as 100. */
export function scrollBucket(fraction: number): ScrollBucket {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0
  if (fraction >= 0.98) return 100
  return SCROLL_BUCKETS[Math.min(3, Math.floor(fraction * 4))]!
}

/** Keyboard shortcuts counted in `session_summary.shortcuts`. */
export const SHORTCUTS = [
  'command_palette',
  'back',
  'forward',
  'zoom_in',
  'zoom_out',
  'zoom_reset',
  'clipboard_popup',
  'dictation'
] as const
export type AnalyticsShortcut = (typeof SHORTCUTS)[number]

/** Command palette choices counted in `session_summary.commands`. */
export const PALETTE_COMMANDS = ['go_to', 'open_result', 'see_all'] as const
export type PaletteCommand = (typeof PALETTE_COMMANDS)[number]

/** What a notification opens: its type, never its content. */
export const NOTIFICATION_TYPES = ['actions', 'day', 'replay', 'meetings', 'chat'] as const

/** How a file reached the chat composer. */
export const CHAT_INPUT_METHODS = ['drop', 'paste'] as const

/** What the person did with an error toast. */
export const ERROR_RESPONSES = ['action', 'dismiss'] as const

/** Events the renderer may report, with the only properties main will forward. */
export interface RendererAnalyticsEvents {
  screen_viewed: { screen: string; prev_screen: string | null; prev_ms: number }
  message_sent: { has_image: boolean; has_document: boolean; tools_enabled: boolean }
  reply_regenerated: Record<string, never>
  feature_used: { feature: AnalyticsFeature }
  problem_reported: Record<string, never>
  // Counted on the device into `session_summary`; never sent one by one.
  ui_action: { screen: string; action: string }
  scroll_depth: { screen: string; pct: ScrollBucket }
  shortcut_used: { shortcut: AnalyticsShortcut }
  command_used: { command: PaletteCommand; target?: string }
  error_shown: { error_code: string }
  error_response: { error_code: string; response: (typeof ERROR_RESPONSES)[number] }
  empty_state_seen: { screen: string }
  notification_clicked: { type: (typeof NOTIFICATION_TYPES)[number] }
  chat_input: { method: (typeof CHAT_INPUT_METHODS)[number]; extension: string }
}
export type RendererAnalyticsEvent = keyof RendererAnalyticsEvents

/** A renderer error, before main scrubs it. */
export interface RendererErrorReport {
  name?: string
  message?: string
  stack?: string
}

export const SUPPORT_EMAIL = 'support@getoffgridai.co'

/** Days between two consent prompts after a failure. */
export const FAILURE_PROMPT_INTERVAL_DAYS = 30
