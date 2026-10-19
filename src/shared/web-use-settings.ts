import {
  DEFAULT_COMPUTER_USE_SETTINGS,
  normalizeComputerUseSettings,
  type ComputerUseSettings
} from './computer-use-settings'

/**
 * Where web_use runs. 'in_app' is Off Grid AI's own browser. 'default_browser' is the user's
 * default browser through the paired extension, signed in as the user; it applies only while
 * that browser is connected, otherwise tasks run in the Off Grid AI browser as before.
 */
export type WebUseBrowserTarget = 'in_app' | 'default_browser'

/** One model of the planner_actor_evaluator strategy: an OpenAI-compatible chat endpoint
 *  (a llama.cpp server per model, so all three stay loaded at the same time). */
export interface WebUseAgentEndpoint {
  baseUrl: string
  model: string
  /** A general model not trained on the contract: it gets the role's instructions first
   *  (AGENT_ROLE_INSTRUCTIONS). The fine-tuned models get the bare request, as in training. */
  instructions?: boolean
  /** Actor and evaluator only: read the ranked page view (the full page cut to the lines that
   *  matter for the step, by the web page ranker) instead of the 18k cut. The model must be trained
   *  on that view. */
  rankedView?: boolean
}

export interface WebUseAgentModels {
  planner: WebUseAgentEndpoint
  actor: WebUseAgentEndpoint
  evaluator: WebUseAgentEndpoint
  /** Writes the answer from the final page after a success verdict; the planner when absent. */
  answerer?: WebUseAgentEndpoint
}

export type WebUseSettings = ComputerUseSettings & {
  browserTarget: WebUseBrowserTarget
  agentModels: WebUseAgentModels
}

export const WEB_USE_SETTINGS_KEY = 'webUseSettings'

export const DEFAULT_WEB_USE_SETTINGS: Readonly<WebUseSettings> = {
  ...DEFAULT_COMPUTER_USE_SETTINGS,
  modelStrategy: 'same_as_chat',
  browserTarget: 'in_app',
  agentModels: {
    planner: { baseUrl: 'http://127.0.0.1:8471/v1', model: 'planner' },
    actor: { baseUrl: 'http://127.0.0.1:8472/v1', model: 'actor' },
    evaluator: { baseUrl: 'http://127.0.0.1:8473/v1', model: 'evaluator' }
  }
}

function normalizeAgentEndpoint(
  value: unknown,
  fallback: WebUseAgentEndpoint
): WebUseAgentEndpoint {
  const input = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof WebUseAgentEndpoint, unknown>
  >
  const baseUrl =
    typeof input.baseUrl === 'string' && /^https?:\/\//i.test(input.baseUrl.trim())
      ? input.baseUrl.trim().replace(/\/+$/, '')
      : fallback.baseUrl
  const model =
    typeof input.model === 'string' && input.model.trim() ? input.model.trim() : fallback.model
  return {
    baseUrl,
    model,
    ...(input.instructions === true ? { instructions: true } : {}),
    ...(input.rankedView === true ? { rankedView: true } : {})
  }
}

function normalizeAgentModels(value: unknown): WebUseAgentModels {
  const input = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof WebUseAgentModels, unknown>
  >
  const defaults = DEFAULT_WEB_USE_SETTINGS.agentModels
  return {
    planner: normalizeAgentEndpoint(input.planner, defaults.planner),
    actor: normalizeAgentEndpoint(input.actor, defaults.actor),
    evaluator: normalizeAgentEndpoint(input.evaluator, defaults.evaluator),
    ...(input.answerer
      ? { answerer: normalizeAgentEndpoint(input.answerer, defaults.planner) }
      : {})
  }
}

export function normalizeWebUseSettings(value: unknown): WebUseSettings {
  const input = typeof value === 'object' && value !== null ? value : {}
  const {
    browserTarget: target,
    modelStrategy,
    agentModels
  } = input as {
    browserTarget?: unknown
    modelStrategy?: unknown
    agentModels?: unknown
  }
  const normalized = normalizeComputerUseSettings({ ...DEFAULT_WEB_USE_SETTINGS, ...input })
  return {
    ...normalized,
    // Computer Use has no planner_actor_evaluator strategy; Web Use keeps it.
    modelStrategy:
      modelStrategy === 'planner_actor_evaluator' ? modelStrategy : normalized.modelStrategy,
    browserTarget: target === 'default_browser' ? 'default_browser' : 'in_app',
    agentModels: normalizeAgentModels(agentModels)
  }
}

/** Said on a task that ran in the Off Grid AI browser although Tasks > Web Use chose the default
 *  browser, because no browser with the extension was connected. */
export const DEFAULT_BROWSER_FALLBACK_NOTE =
  'Ran in the Off Grid AI browser: your browser was not connected.'
