// SHARED VERBATIM with off-grid-ai/browser-extension src/shared/bridge/settings.ts. Change both.
// Off Grid AI Desktop's settings, as a paired browser sees and changes them (sealed RPC
// `settings.get` / `settings.set`). The panel's Settings tabs mirror the desktop's: Tasks,
// Tools, Connectors, Image, Transcription and Voice. Text is also available through sealed settings RPC.
//
// THIS FILE IS SHARED VERBATIM with the desktop (src/main/extension-bridge/bridge-settings.ts).
// Change both, or neither.
//
// The desktop is the authority. A browser may only send the keys listed here, with these
// types and bounds; the desktop then saves them through the same functions its own Settings
// screen uses, which normalise every value. API keys, file paths and model downloads are not
// reachable from here.

export const SETTINGS_SECTIONS = [
  'text',
  'remote',
  'tasks',
  'tools',
  'connectors',
  'image',
  'transcription',
  'voice'
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export const isSettingsSection = (v: unknown): v is SettingsSection =>
  (SETTINGS_SECTIONS as readonly unknown[]).includes(v)

// ---- What the desktop answers ---------------------------------------------------------------

export interface ModelChoice {
  readonly id: string
  readonly label: string
}

/** Desktop's text settings and derived choices. No runtime paths leave Desktop. */
export interface TextSettings {
  readonly temperature?: number
  readonly ctxSize?: number
  readonly topP?: number
  readonly topK?: number
  readonly minP?: number
  readonly repeatPenalty?: number
  readonly maxTokens?: number
  readonly maxToolCalls?: number
  readonly reasoningBudget?: number
  readonly systemPrompt?: string
  readonly kvCacheType?: 'f16' | 'q8_0' | 'q4_0'
  readonly flashAttn?: boolean
  readonly gpuLayers?: number
  readonly threads?: number
  readonly batchSize?: number
  readonly speculativeDecoding?: 'off' | 'ngram' | 'mtp' | 'draft' | 'dflash'
  readonly speculativeDraftMax?: number
  readonly draftModel?: string
  readonly options?: {
    readonly thinkingBudgets: readonly number[]
    readonly speculativeModes: readonly {
      readonly value: 'off' | 'ngram' | 'mtp' | 'draft' | 'dflash'
      readonly label: string
      readonly disabled: boolean
    }[]
    readonly draftModels: readonly ModelChoice[]
    readonly dflashModels: readonly ModelChoice[]
  }
  readonly activeModelId?: string | null
  readonly availability?: {
    readonly vision: boolean
    readonly agent: boolean
    readonly reasonIfNot?: string
  }
  readonly modelsByTab?: Readonly<
    Record<string, readonly (ModelChoice & { readonly active: boolean })[]>
  >
}

export interface TaskStrategyOption {
  readonly value: string
  readonly available: boolean
  readonly reasonIfNot?: string
  readonly decision: readonly ModelChoice[]
  readonly grounding: readonly ModelChoice[]
  readonly reasoner: readonly ModelChoice[]
}

/** Saved remote servers, by name and host only: endpoints' paths and API keys stay put. */
export interface RemoteSettings {
  /** Chat runs on the active remote server rather than this machine. */
  readonly active: boolean
  readonly activeServerId: string | null
  readonly servers: readonly {
    readonly id: string
    readonly name: string
    readonly host: string
    /** The server's text model, by name. Empty when none is chosen on the desktop. */
    readonly model: string
    readonly available?: boolean
    readonly reasonIfNot?: string
  }[]
}

/** Web Use and Computer Use options with fixed choices (the desktop's Tasks tab). */
export interface TaskOptions {
  readonly modelStrategy: string
  readonly context: string
  readonly screenshotSize: string
  readonly visualHistoryFrames: number
  readonly checkpointInterval: number
}

export interface TasksSettings {
  readonly strategies?: readonly TaskStrategyOption[]
  readonly options?: {
    readonly contexts: readonly string[]
    readonly screenshotSizes: readonly string[]
    readonly visualHistory: readonly number[]
    readonly checkpoints: readonly number[]
    readonly rails: readonly string[]
    readonly browserTargets: readonly string[]
  }
  /** Shared by Web Use and Computer Use. Empty when none is chosen. */
  readonly grounding: string
  readonly groundingChoices: readonly ModelChoice[]
  /** Decider models for the decision strategies; '' means the default. */
  readonly decisionChoices: readonly ModelChoice[]
  readonly web: TaskOptions & {
    readonly browserTarget: 'in_app' | 'default_browser'
    readonly decisionModelId: string
  }
  readonly computer: TaskOptions & {
    readonly showPictureInPicture: boolean
    readonly enabledRails: readonly string[]
    readonly decisionModelId: string
  }
}

export interface ToolsSettings {
  readonly enabled: boolean
  readonly tools: readonly { name: string; description: string; enabled: boolean }[]
}

/** How an account stands: usable, waiting for a new sign-in on the desktop, or switched off. */
export type AccountHealth = 'connected' | 'needs-sign-in' | 'off'

export interface ConnectorsSettings {
  readonly connectors: readonly {
    id: string
    name: string
    url: string
    enabled: boolean
    /**
     * An account (Google, Microsoft, an Obsidian vault, a work tool): read live when asked and
     * never copied into memory. Accounts are added and signed in to on the desktop.
     */
    liveOnly?: boolean
    health?: AccountHealth
    /** What the account can read, as the desktop names it (Gmail, Calendar, ...). */
    services?: readonly string[]
    /** Picked, but not granted at sign-in. */
    missing?: readonly string[]
  }[]
}

export interface ImageSettings {
  /** The active image model, or null when none is set up. */
  readonly model: string | null
  readonly size: number
  readonly steps: number
  readonly cfgScale: number
  readonly seed: string
  readonly negative: string
  readonly enhance: boolean
}

export interface TranscriptionSettings {
  readonly language: string
  /** What the active transcription model understands; 'auto' detects it. */
  readonly languages: readonly { code: string; label: string }[]
}

export interface VoiceSettings {
  readonly ttsEnabled: boolean
  readonly voice: string
  readonly speed: number // Playback rate, 0.5 to 2, as on the desktop's Voice tab.
}

export interface SettingsBySection {
  text?: TextSettings
  remote: RemoteSettings
  tasks: TasksSettings
  tools: ToolsSettings
  connectors: ConnectorsSettings
  image: ImageSettings
  transcription: TranscriptionSettings
  voice: VoiceSettings
}

// ---- What a browser may send ----------------------------------------------------------------

export const TASK_STRATEGIES = [
  'same_as_chat',
  'separate_specialist',
  'text_plus_specialist',
  'decision_plus_specialist',
  'decision_plus_reasoning'
] as const
export const TASK_CONTEXTS = ['auto', '16k', '32k'] as const
export const SCREENSHOT_SIZES = ['compact', 'balanced', 'large'] as const
export const VISUAL_HISTORY = [0, 1, 2, 5, 10] as const
export const CHECKPOINTS = [8, 9, 10] as const
export const RAILS = ['ax', 'vision'] as const
export const BROWSER_TARGETS = ['in_app', 'default_browser'] as const
export const IMAGE_SIZES = [256, 512, 640, 768, 1024] as const

type Patch = Record<string, unknown>
type Rule = (v: unknown) => unknown | undefined

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const oneOf =
  <T>(choices: readonly T[]): Rule =>
  (v) =>
    choices.includes(v as T) ? v : undefined
const bool: Rule = (v) => (typeof v === 'boolean' ? v : undefined)
const text =
  (max: number, pattern?: RegExp): Rule =>
  (v) =>
    typeof v === 'string' && v.length <= max && (!pattern || pattern.test(v)) ? v : undefined
const int =
  (min: number, max: number): Rule =>
  (v) =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? v : undefined
const num =
  (min: number, max: number): Rule =>
  (v) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined
const rails: Rule = (v) =>
  Array.isArray(v) && v.length > 0 && v.every((r) => (RAILS as readonly unknown[]).includes(r))
    ? [...new Set(v)]
    : undefined

/** Keep the listed keys that pass their rule. Null when nothing valid is left. */
function pick(raw: unknown, rules: Record<string, Rule>): Patch | null {
  if (!isObj(raw)) {
    return null
  }
  const out: Patch = {}
  for (const [key, rule] of Object.entries(rules)) {
    if (Object.hasOwn(raw, key)) {
      const value = rule(raw[key])
      if (value !== undefined) {
        out[key] = value
      }
    }
  }
  return Object.keys(out).length ? out : null
}

const TASK_RULES: Record<string, Rule> = {
  modelStrategy: oneOf(TASK_STRATEGIES),
  context: oneOf(TASK_CONTEXTS),
  screenshotSize: oneOf(SCREENSHOT_SIZES),
  visualHistoryFrames: oneOf(VISUAL_HISTORY),
  checkpointInterval: oneOf(CHECKPOINTS)
}

const nested =
  (rules: Record<string, Rule>): Rule =>
  (v) =>
    pick(v, rules) ?? undefined

// A plain web address. An account's internal identity on the desktop (a URL carrying
// offgrid-services) is not something a browser can add: accounts are signed in to on the desktop.
const HTTP_URL = /^https?:\/\/(?![^\s]*offgrid-services=)[^\s]+$/

const MODEL_ID = text(400, /^\S*$/)
const yes: Rule = (v) => (v === true ? v : undefined)

const SECTION_RULES: Record<SettingsSection, Record<string, Rule>> = {
  // Only switching between saved servers: adding one, its models and keys stay on the desktop.
  text: {
    temperature: num(0, 2),
    ctxSize: int(1, 1048576),
    topP: num(0, 1),
    topK: int(0, 1000),
    minP: num(0, 1),
    repeatPenalty: num(0, 10),
    maxTokens: int(0, 1048576),
    maxToolCalls: int(0, 1000),
    reasoningBudget: int(0, 1048576),
    kvCacheType: oneOf(['f16', 'q8_0', 'q4_0']),
    flashAttn: bool,
    gpuLayers: int(-1, 1000),
    threads: int(0, 1024),
    batchSize: int(1, 65536),
    speculativeDecoding: oneOf(['off', 'ngram', 'mtp', 'draft', 'dflash']),
    speculativeDraftMax: int(0, 16),
    draftModel: text(400, /^[^/\\]*$/)
  },
  remote: { use: text(200, /^\S+$/), off: yes },
  tasks: {
    grounding: text(400, /^\S+$/),
    web: nested({
      ...TASK_RULES,
      browserTarget: oneOf(BROWSER_TARGETS),
      decisionModelId: MODEL_ID
    }),
    computer: nested({
      ...TASK_RULES,
      showPictureInPicture: bool,
      enabledRails: rails,
      decisionModelId: MODEL_ID
    })
  },
  tools: {
    enabled: bool,
    tool: nested({ name: text(200, /^\S+$/), enabled: bool })
  },
  connectors: {
    add: nested({ name: text(80, /\S/), url: text(2000, HTTP_URL) }),
    setEnabled: nested({ id: text(100, /^\S+$/), enabled: bool }),
    remove: text(100, /^\S+$/)
  },
  image: {
    size: oneOf(IMAGE_SIZES),
    steps: int(1, 50),
    cfgScale: num(0, 20),
    seed: text(12, /^\d*$/),
    negative: text(2000),
    enhance: bool
  },
  transcription: { language: text(12, /^(auto|[a-z]{2,3}(-[A-Za-z]{2,4})?)$/) },
  voice: { ttsEnabled: bool, voice: text(64, /^[\w.-]+$/), speed: num(0.5, 2) }
}

/**
 * The part of a browser's patch the desktop may apply: listed keys, valid values, nothing
 * else. A nested change (a tool switch, a connector) must be whole to count. Null when
 * nothing valid is left, which the desktop refuses as invalid.
 */
export function parseSettingsPatch(section: SettingsSection, raw: unknown): Patch | null {
  const patch = pick(raw, SECTION_RULES[section])
  if (!patch) {
    return null
  }
  const whole: Record<string, readonly string[]> = {
    tool: ['name', 'enabled'],
    add: ['name', 'url'],
    setEnabled: ['id', 'enabled']
  }
  for (const [key, needs] of Object.entries(whole)) {
    const v = patch[key]
    if (isObj(v) && !needs.every((n) => Object.hasOwn(v, n))) {
      delete patch[key]
    }
  }
  return Object.keys(patch).length ? patch : null
}
