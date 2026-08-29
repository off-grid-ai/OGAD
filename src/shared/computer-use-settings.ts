export type ComputerUseContext = 'auto' | '16k' | '32k'
export type ComputerUseScreenshotSize = 'compact' | 'balanced' | 'large'
export type ComputerUseScreenshotQuality = 'efficient' | 'balanced' | 'detailed'
export type ComputerUseCheckpointInterval = 8 | 9 | 10
export type ComputerUseVisualHistoryFrames = 0 | 1 | 2 | 5
export type ComputerUseModelStrategy =
  | 'same_as_chat'
  | 'separate_specialist'
  | 'text_plus_specialist'

export interface ComputerUseSettings {
  modelStrategy: ComputerUseModelStrategy
  context: ComputerUseContext
  screenshotSize: ComputerUseScreenshotSize
  screenshotQuality: ComputerUseScreenshotQuality
  checkpointInterval: ComputerUseCheckpointInterval
  visualHistoryFrames: ComputerUseVisualHistoryFrames
  retrieveOlderVisuals: boolean
}

export interface ComputerUseActiveModel {
  role: 'reasoner' | 'grounding_specialist'
  modelId: string
  modelName: string
  remote: boolean
}

/** Read-only Active Models projection. Strategy and role composition are
 * resolved in main; the renderer never becomes a second selection owner. */
export interface ComputerUseActiveModelProjection {
  strategy: ComputerUseModelStrategy
  strategyLabel: string
  models: ComputerUseActiveModel[]
}

export const COMPUTER_USE_SETTINGS_KEY = 'computerUseSettings'

export const DEFAULT_COMPUTER_USE_SETTINGS: Readonly<ComputerUseSettings> = {
  modelStrategy: 'separate_specialist',
  context: 'auto',
  screenshotSize: 'balanced',
  screenshotQuality: 'balanced',
  checkpointInterval: 9,
  visualHistoryFrames: 2,
  retrieveOlderVisuals: false
}

const CONTEXT_TOKENS: Record<Exclude<ComputerUseContext, 'auto'>, number> = {
  '16k': 16_384,
  '32k': 32_768
}

export const SCREENSHOT_MAX_EDGE: Record<ComputerUseScreenshotSize, number> = {
  compact: 1_024,
  balanced: 1_440,
  large: 1_920
}

export const SCREENSHOT_RESIZE_QUALITY: Record<
  ComputerUseScreenshotQuality,
  'good' | 'better' | 'best'
> = {
  efficient: 'good',
  balanced: 'better',
  detailed: 'best'
}

/** The sharp resize kernel for each screenshot quality - the same setting
 * SCREENSHOT_RESIZE_QUALITY maps for Electron's NativeImage.resize. */
export const SCREENSHOT_RESIZE_KERNEL: Record<
  ComputerUseScreenshotQuality,
  'nearest' | 'cubic' | 'lanczos3'
> = {
  efficient: 'nearest',
  balanced: 'cubic',
  detailed: 'lanczos3'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function normalizeComputerUseSettings(value: unknown): ComputerUseSettings {
  const input = isRecord(value) ? value : {}
  const context =
    input.context === '16k' || input.context === '32k' || input.context === 'auto'
      ? input.context
      : DEFAULT_COMPUTER_USE_SETTINGS.context
  const screenshotSize =
    input.screenshotSize === 'compact' ||
    input.screenshotSize === 'balanced' ||
    input.screenshotSize === 'large'
      ? input.screenshotSize
      : DEFAULT_COMPUTER_USE_SETTINGS.screenshotSize
  const screenshotQuality =
    input.screenshotQuality === 'efficient' ||
    input.screenshotQuality === 'balanced' ||
    input.screenshotQuality === 'detailed'
      ? input.screenshotQuality
      : DEFAULT_COMPUTER_USE_SETTINGS.screenshotQuality
  const checkpoint =
    typeof input.checkpointInterval === 'number'
      ? Math.max(8, Math.min(10, Math.round(input.checkpointInterval)))
      : DEFAULT_COMPUTER_USE_SETTINGS.checkpointInterval
  const visualHistoryFrames =
    input.visualHistoryFrames === 0 ||
    input.visualHistoryFrames === 1 ||
    input.visualHistoryFrames === 2 ||
    input.visualHistoryFrames === 5
      ? input.visualHistoryFrames
      : DEFAULT_COMPUTER_USE_SETTINGS.visualHistoryFrames

  return {
    modelStrategy:
      input.modelStrategy === 'same_as_chat' ||
      input.modelStrategy === 'separate_specialist' ||
      input.modelStrategy === 'text_plus_specialist'
        ? input.modelStrategy
        : DEFAULT_COMPUTER_USE_SETTINGS.modelStrategy,
    context,
    screenshotSize,
    screenshotQuality,
    checkpointInterval: checkpoint as ComputerUseCheckpointInterval,
    visualHistoryFrames,
    retrieveOlderVisuals:
      typeof input.retrieveOlderVisuals === 'boolean'
        ? input.retrieveOlderVisuals
        : DEFAULT_COMPUTER_USE_SETTINGS.retrieveOlderVisuals
  }
}

/** The model process owns the real context ceiling. Computer Use can ask for less,
 * never more. Auto uses that current effective ceiling. */
export function resolveComputerUseContextTokens(
  context: ComputerUseContext,
  effectiveContextTokens: number
): number {
  const safeEffective =
    Number.isFinite(effectiveContextTokens) && effectiveContextTokens >= 2_048
      ? Math.floor(effectiveContextTokens)
      : 2_048
  const requested = context === 'auto' ? safeEffective : CONTEXT_TOKENS[context]
  return Math.min(requested, safeEffective)
}

/** Keep most of the selected context available for the current screenshot,
 * instructions, and response. Only the bounded action ledger uses this share. */
export function computerUseHistoryTokenBudget(contextTokens: number): number {
  const safe = Number.isFinite(contextTokens) ? Math.max(2_048, Math.floor(contextTokens)) : 2_048
  return Math.max(512, Math.floor(safe / 4))
}

/** Approximate prompt-token budget without a tokenizer dependency. Always keep the
 * newest entries and never split one entry. */
export function tailWithinTokenBudget(lines: readonly string[], tokenBudget: number): string[] {
  const charBudget = Math.max(0, Math.floor(tokenBudget)) * 4
  const kept: string[] = []
  let used = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line === undefined) continue
    const cost = line.length + 1
    if (used + cost > charBudget) break
    kept.unshift(line)
    used += cost
  }
  return kept
}
