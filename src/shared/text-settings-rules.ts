import {
  REASONING_BUDGET_AUTO,
  REASONING_BUDGET_OPTIONS,
  optionsWithinCeiling,
  reconcileBudgets
} from '@offgrid/models'
import { DEFAULT_CTX_SIZE, MAX_TOKENS_AUTO } from './llm-defaults'

const MAX_OUTPUT_AUTO = MAX_TOKENS_AUTO
export type SpeculativeMode = 'off' | 'ngram' | 'mtp' | 'draft' | 'dflash'
export interface TextRuleSettings {
  ctxSize?: number
  maxTokens?: number
  reasoningBudget?: number
  speculativeDecoding?: SpeculativeMode
  draftModel?: string
  supportsMtp?: boolean
  compatibleDraftModels?: readonly string[]
  compatibleDflashModels?: readonly string[]
}

/** The ceiling on thinking: the response length it must fit inside, which for an auto output cap
 *  is the context window. Mirrors reconcileBudgets so the options offered match what is kept. */
export function thinkingCeiling(s: TextRuleSettings): number {
  const maxOutput = s.maxTokens ?? MAX_OUTPUT_AUTO
  const ctx = s.ctxSize ?? DEFAULT_CTX_SIZE
  return maxOutput === MAX_OUTPUT_AUTO ? ctx : maxOutput
}

/**
 * Apply one budget edit and pull the inner budgets back under it.
 *
 * Filtering the option lists stops a user PICKING an impossible combination; this stops an already
 * stored one surviving a change to an outer limit. Both read the same rule from @offgrid/models,
 * so the picker and the persisted value cannot disagree. Only genuinely changed fields are
 * returned, so an unrelated edit does not rewrite the other two.
 */
export function budgetChange<T extends TextRuleSettings>(s: T, patch: T): T {
  const next = { ...s, ...patch }
  const reconciled = reconcileBudgets({
    contextWindow: next.ctxSize ?? DEFAULT_CTX_SIZE,
    maxOutput: next.maxTokens ?? MAX_OUTPUT_AUTO,
    thinkingBudget: next.reasoningBudget ?? REASONING_BUDGET_AUTO
  })
  return {
    ...patch,
    ...(reconciled.maxOutput !== (next.maxTokens ?? MAX_OUTPUT_AUTO)
      ? { maxTokens: reconciled.maxOutput }
      : {}),
    ...(reconciled.thinkingBudget !== (next.reasoningBudget ?? REASONING_BUDGET_AUTO)
      ? { reasoningBudget: reconciled.thinkingBudget }
      : {})
  }
}

export function thinkingBudgetOptions(s: TextRuleSettings): number[] {
  return [
    REASONING_BUDGET_AUTO,
    ...optionsWithinCeiling(REASONING_BUDGET_OPTIONS, thinkingCeiling(s))
  ]
}

export function speculativeOptions(
  s: TextRuleSettings
): { value: SpeculativeMode; label: string; disabled: boolean }[] {
  return [
    { value: 'off', label: 'Off', disabled: false },
    { value: 'ngram', label: 'N-gram', disabled: false },
    {
      value: 'mtp',
      label: s.supportsMtp === false ? 'MTP · Not supported by this model' : 'MTP',
      disabled: s.supportsMtp === false
    },
    { value: 'draft', label: 'Draft model', disabled: !s.compatibleDraftModels?.length },
    { value: 'dflash', label: 'DFlash', disabled: !s.compatibleDflashModels?.length }
  ]
}

export function speculativePatch<T extends TextRuleSettings>(s: TextRuleSettings, patch: T): T {
  const next = { ...s, ...patch }
  const mode = next.speculativeDecoding ?? 'off'
  if (speculativeOptions(s).find((option) => option.value === mode)?.disabled) {
    return { ...patch, speculativeDecoding: 'off' }
  }
  const drafts =
    mode === 'draft'
      ? s.compatibleDraftModels
      : mode === 'dflash'
        ? s.compatibleDflashModels
        : undefined
  return drafts?.length && !drafts.includes(next.draftModel ?? '')
    ? { ...patch, draftModel: drafts[0] }
    : patch
}

export type DraftModelOption = { value: string; label: string }
export type DraftCatalogModel = {
  id: string
  name: string
  kind?: string
  tags?: string[]
  files?: Array<{ name: string; role?: string }>
}
export type DraftCompanionStatus = Record<
  string,
  { dflashInstalled?: boolean; dflashFile?: string }
>

export function installedDraftModels(
  models: readonly DraftCatalogModel[],
  activeModelId: string | null,
  companionStatus: DraftCompanionStatus,
  compatibleDraftFiles: readonly string[],
  compatibleDflashFiles: readonly string[]
): { draft: DraftModelOption[]; dflash: DraftModelOption[] } {
  const draftFiles = new Set(compatibleDraftFiles)
  const dflashFiles = new Set(compatibleDflashFiles)
  const draft = new Map<string, DraftModelOption>()
  const dflashOptions = new Map<string, DraftModelOption>()
  for (const model of models) {
    const dflash = companionStatus[model.id]
    if (dflash?.dflashInstalled && dflash.dflashFile && dflashFiles.has(dflash.dflashFile)) {
      dflashOptions.set(dflash.dflashFile, {
        value: dflash.dflashFile,
        label: `${model.name} · DFlash`
      })
    }
    if (model.id === activeModelId) continue
    if (!model.tags?.some((tag) => tag === 'Imported' || tag === 'Downloaded')) continue
    if (model.kind && !['text', 'vision', 'local'].includes(model.kind)) continue
    const primary = model.files?.find(
      (file) =>
        file.name.toLowerCase().endsWith('.gguf') &&
        file.role !== 'mmproj' &&
        !/(?:^|[-_.])(mmproj|projector)(?:[-_.]|$)/i.test(file.name)
    )?.name
    if (primary && draftFiles.has(primary)) {
      draft.set(primary, { value: primary, label: model.name })
    }
  }
  return { draft: [...draft.values()], dflash: [...dflashOptions.values()] }
}
