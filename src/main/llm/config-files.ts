import fs from 'node:fs'
import path from 'node:path'
import {
  defaultChatModelArtifacts,
  isPerformanceMode,
  isReasoningEffort,
  normalizeMaxToolCalls,
  type PresetField
} from '@offgrid/models'
import type { LlmSettings } from './contracts'

export type ConfigRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly value: Record<string, unknown> }
  | { readonly kind: 'unreadable'; readonly reason: string }

export function readJsonConfig(file: string): ConfigRead {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unreadable', reason: (error as Error).message }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return { kind: 'unreadable', reason: 'the file does not contain a JSON object' }
    }
    return { kind: 'ok', value: parsed as Record<string, unknown> }
  } catch (error) {
    return { kind: 'unreadable', reason: (error as Error).message }
  }
}

export function quarantineUnreadableConfig(file: string, reason: string): void {
  const quarantined = `${file}.unreadable`
  try {
    fs.rmSync(quarantined, { force: true })
    fs.renameSync(file, quarantined)
    console.error(
      `[LLMService] ${path.basename(file)} could not be read (${reason}); kept as ${path.basename(quarantined)} and continuing with defaults`
    )
  } catch (error) {
    console.error(
      `[LLMService] ${path.basename(file)} could not be read (${reason}) AND could not be moved aside`,
      error
    )
  }
}

export function readJsonConfigOrNull(file: string): Record<string, unknown> | null {
  const read = readJsonConfig(file)
  if (read.kind === 'ok') return read.value
  if (read.kind === 'unreadable') quarantineUnreadableConfig(file, read.reason)
  return null
}

export function resolveActiveModelPaths(
  directory: string,
  selection: Record<string, unknown> | null
): { modelPath: string; projectorPath: string } {
  if (typeof selection?.primary === 'string' && selection.primary) {
    return {
      modelPath: path.join(directory, selection.primary),
      projectorPath:
        typeof selection.mmproj === 'string' && selection.mmproj
          ? path.join(directory, selection.mmproj)
          : ''
    }
  }
  const artifacts = defaultChatModelArtifacts()
  return {
    modelPath: path.join(directory, artifacts.primary),
    projectorPath: artifacts.projector ? path.join(directory, artifacts.projector) : ''
  }
}

export function storedLlmSettings(source: Record<string, unknown>): {
  settings: LlmSettings
  explicit: PresetField[]
} {
  const settings: LlmSettings = {}
  const numericKeys = [
    'temperature',
    'ctxSize',
    'topP',
    'topK',
    'minP',
    'repeatPenalty',
    'maxTokens',
    'reasoningBudget',
    'gpuLayers',
    'threads',
    'batchSize'
  ] as const
  for (const key of numericKeys) {
    if (typeof source[key] === 'number') settings[key] = source[key]
  }
  if (typeof source.maxToolCalls === 'number') {
    settings.maxToolCalls = normalizeMaxToolCalls(source.maxToolCalls)
  }
  if (isReasoningEffort(source.reasoningEffort)) settings.reasoningEffort = source.reasoningEffort
  if (typeof source.thinkingEnabled === 'boolean') {
    settings.thinkingEnabled = source.thinkingEnabled
  }
  if (typeof source.systemPrompt === 'string') settings.systemPrompt = source.systemPrompt
  if (
    source.kvCacheType === 'f16' ||
    source.kvCacheType === 'q8_0' ||
    source.kvCacheType === 'q4_0'
  ) {
    settings.kvCacheType = source.kvCacheType
  }
  if (typeof source.flashAttn === 'boolean') settings.flashAttn = source.flashAttn
  if (isPerformanceMode(source.performanceMode)) settings.performanceMode = source.performanceMode
  const explicit = Array.isArray(source.userExplicit)
    ? source.userExplicit.filter(
        (field): field is PresetField =>
          field === 'ctxSize' || field === 'kvCacheType' || field === 'flashAttn'
      )
    : []
  return { settings, explicit }
}
