import { useEffect, useState } from 'react'
import { formatContextWindow, resolveActiveTextModel } from '../lib/model-summary'
import { recommendedContextWindow } from '../lib/ctx-options'
import { LLM_SETTINGS_INVALIDATED_EVENT } from '../lib/settings-invalidation'

type ActiveModelApi = Partial<
  Pick<
    typeof window.api,
    'getModelCatalog' | 'getActiveModel' | 'getActiveModelIds' | 'getLlmSettings'
  >
>

export interface ActiveModelSummary {
  /** Display name of the active text/vision model, or null if none. */
  name: string | null
  /** Compact running context window, e.g. "8K", or null if unknown. */
  ctx: string | null
  /** Stored selection before model/RAM clamps. */
  configuredCtx: string | null
  /** Capture-safe recommendation for this model. */
  recommendedCtx: string | null
  /** The model runs on a remote server, whose own setting decides its window. */
  remote?: boolean
  /** True once the catalog was read: no name then means no chat model, not still loading. */
  known?: boolean
}

/** Read the active text model + its running context window for the composer indicator.
 *  Pass a value that changes when the model may have changed (e.g. the model-picker
 *  open flag) so the chip refreshes after a switch. All formatting lives in the pure
 *  model-summary helpers; this hook only does the IPC reads. */
export function useActiveModelSummary(refreshWhen: unknown): ActiveModelSummary {
  const [settingsRevision, setSettingsRevision] = useState(0)
  const [summary, setSummary] = useState<ActiveModelSummary>({
    name: null,
    ctx: null,
    configuredCtx: null,
    recommendedCtx: null
  })

  useEffect(() => {
    const invalidate = (): void => setSettingsRevision((revision) => revision + 1)
    window.addEventListener(LLM_SETTINGS_INVALIDATED_EVENT, invalidate)
    return () => window.removeEventListener(LLM_SETTINGS_INVALIDATED_EVENT, invalidate)
  }, [])

  useEffect(() => {
    const request = { active: true }
    void (async (): Promise<void> => {
      const api = window.api as ActiveModelApi | undefined
      try {
        const catalog = await api?.getModelCatalog?.()
        const activeId = (await api?.getActiveModel?.()) ?? null
        const activeIds = new Set<string>((await api?.getActiveModelIds?.()) ?? [])
        const settings = await api?.getLlmSettings?.()
        if (!request.active) {
          return
        }
        const activeModel = resolveActiveTextModel(catalog?.models ?? [], activeId, activeIds)
        // The same window chat budgets read; a remote server that does not report one shows none.
        const contextWindow = settings?.contextWindow as
          { tokens: number; remote: boolean; reported: boolean } | undefined
        setSummary({
          name: activeModel.name,
          ctx: contextWindow
            ? contextWindow.reported
              ? formatContextWindow(contextWindow.tokens)
              : null
            : activeModel.remote
              ? null
              : formatContextWindow(settings?.effectiveCtxSize ?? settings?.ctxSize),
          configuredCtx: activeModel.remote ? null : formatContextWindow(settings?.ctxSize),
          recommendedCtx: activeModel.remote
            ? null
            : formatContextWindow(recommendedContextWindow(settings?.modelMaxCtx)),
          remote: Boolean(activeModel.remote),
          known: true
        })
      } catch {
        if (request.active)
          setSummary({ name: null, ctx: null, configuredCtx: null, recommendedCtx: null })
      }
    })()
    return () => {
      request.active = false
    }
  }, [refreshWhen, settingsRevision])

  return summary
}
