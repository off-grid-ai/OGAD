import { useEffect, useState } from 'react'
import { formatContextWindow, resolveActiveTextModel } from '../lib/model-summary'
import { recommendedContextWindow } from '../lib/ctx-options'
import { LLM_SETTINGS_INVALIDATED_EVENT } from '../lib/settings-invalidation'
import { desktopModelControl } from '../lib/model-control-application'

type ActiveModelApi = Partial<Pick<typeof window.api, 'getLlmSettings'>>

export interface ActiveModelSummary {
  /** Current projection state. A failure never masquerades as a valid empty selection. */
  status: 'loading' | 'ready' | 'failed'
  /** Typed boundary failure for the composer UI and diagnostics. */
  failure: { code: 'model_control_projection_failed'; message: string } | null
  /** Display name of the active text/vision model, or null if none. */
  name: string | null
  /** Compact running context window, e.g. "8K", or null if unknown. */
  ctx: string | null
  /** Stored selection before model/RAM clamps. */
  configuredCtx: string | null
  /** Capture-safe recommendation for this model. */
  recommendedCtx: string | null
  /** Authoritative active-runtime evidence. Null means the runtime did not publish support. */
  thinking: boolean | null
}

/** Read the active text model + its running context window for the composer indicator.
 *  Pass a value that changes when the model may have changed (e.g. the model-picker
 *  open flag) so the chip refreshes after a switch. All formatting lives in the pure
 *  model-summary helpers; this hook only does the IPC reads. */
export function useActiveModelSummary(refreshWhen: unknown): ActiveModelSummary {
  const [settingsRevision, setSettingsRevision] = useState(0)
  const [summary, setSummary] = useState<ActiveModelSummary>({
    status: 'loading',
    failure: null,
    name: null,
    ctx: null,
    configuredCtx: null,
    recommendedCtx: null,
    thinking: null
  })

  useEffect(() => {
    const invalidate = (): void => setSettingsRevision((revision) => revision + 1)
    window.addEventListener(LLM_SETTINGS_INVALIDATED_EVENT, invalidate)
    return () => window.removeEventListener(LLM_SETTINGS_INVALIDATED_EVENT, invalidate)
  }, [])

  useEffect(() => {
    const request = { active: true }
    setSummary({
      status: 'loading',
      failure: null,
      name: null,
      ctx: null,
      configuredCtx: null,
      recommendedCtx: null,
      thinking: null
    })
    void (async (): Promise<void> => {
      const api = window.api as ActiveModelApi | undefined
      try {
        const projection = await desktopModelControl.project()
        const settings = await api?.getLlmSettings?.()
        if (!request.active) {
          return
        }
        const activeModel = resolveActiveTextModel(projection.models, projection.active.text)
        setSummary({
          status: 'ready',
          failure: null,
          name: activeModel.name,
          ctx: activeModel.remote
            ? null
            : formatContextWindow(settings?.effectiveCtxSize ?? settings?.ctxSize),
          configuredCtx: activeModel.remote ? null : formatContextWindow(settings?.ctxSize),
          recommendedCtx: activeModel.remote
            ? null
            : formatContextWindow(recommendedContextWindow(settings?.modelMaxCtx)),
          thinking: activeModel.thinking
        })
      } catch (error) {
        const failure = {
          code: 'model_control_projection_failed' as const,
          message: error instanceof Error ? error.message : 'Model control projection failed.'
        }
        console.error('[ModelControl] Active model summary projection failed.', error)
        if (request.active) {
          setSummary({
            status: 'failed',
            failure,
            name: null,
            ctx: null,
            configuredCtx: null,
            recommendedCtx: null,
            thinking: null
          })
        }
      }
    })()
    return () => {
      request.active = false
    }
  }, [refreshWhen, settingsRevision])

  return summary
}
