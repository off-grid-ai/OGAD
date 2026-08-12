import { useEffect, useState } from 'react'
import { formatContextWindow, resolveModelName } from '../lib/model-summary'
import { recommendedContextWindow } from '../lib/ctx-options'

type ActiveModelApi = Partial<
  Pick<typeof window.api, 'getModelCatalog' | 'getActiveModel' | 'getLlmSettings'>
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
}

/** Read the active text model + its running context window for the composer indicator.
 *  Pass a value that changes when the model may have changed (e.g. the model-picker
 *  open flag) so the chip refreshes after a switch. All formatting lives in the pure
 *  model-summary helpers; this hook only does the IPC reads. */
export function useActiveModelSummary(refreshWhen: unknown): ActiveModelSummary {
  const [summary, setSummary] = useState<ActiveModelSummary>({
    name: null,
    ctx: null,
    configuredCtx: null,
    recommendedCtx: null
  })

  useEffect(() => {
    const request = { active: true }
    void (async (): Promise<void> => {
      const api = window.api as ActiveModelApi | undefined
      try {
        const catalog = await api?.getModelCatalog?.()
        const activeId = (await api?.getActiveModel?.()) ?? null
        const settings = await api?.getLlmSettings?.()
        if (!request.active) {
          return
        }
        setSummary({
          name: resolveModelName(catalog?.models ?? [], activeId),
          ctx: formatContextWindow(settings?.effectiveCtxSize ?? settings?.ctxSize),
          configuredCtx: formatContextWindow(settings?.ctxSize),
          recommendedCtx: formatContextWindow(recommendedContextWindow(settings?.modelMaxCtx))
        })
      } catch {
        if (request.active)
          setSummary({ name: null, ctx: null, configuredCtx: null, recommendedCtx: null })
      }
    })()
    return () => {
      request.active = false
    }
  }, [refreshWhen])

  return summary
}
