import type {
  AnalyticsFlow,
  FlowOutcome,
  RendererAnalyticsEvent,
  RendererAnalyticsEvents
} from '../../../shared/analytics'

/**
 * The renderer's side of opt-in analytics. Every call goes to main, which sends nothing unless the
 * user opted in and drops any event or property it does not know. Safe where the bridge is absent
 * (tests, isolated surfaces).
 */
export function analyticsBridge(): Partial<Window['api']['analytics']> | undefined {
  // The bridge, or any method of it, is absent in isolated surfaces and component tests.
  const value = (window as { api?: Partial<Window['api']> }).api?.analytics
  return value && typeof value === 'object' ? value : undefined
}
const bridge = analyticsBridge

export function track<E extends RendererAnalyticsEvent>(
  event: E,
  ...properties: RendererAnalyticsEvents[E] extends Record<string, never>
    ? []
    : [RendererAnalyticsEvents[E]]
): void {
  bridge()?.capture?.(event, properties[0])
}

export const flow = {
  start(name: AnalyticsFlow): void {
    bridge()?.flow?.({ flow: name, action: 'start' })
  },
  step(name: AnalyticsFlow, step: string, detail?: string): void {
    bridge()?.flow?.({ flow: name, action: 'step', step, ...(detail ? { detail } : {}) })
  },
  finish(name: AnalyticsFlow, outcome: FlowOutcome, errorCode?: string): void {
    bridge()?.flow?.({ flow: name, action: 'finish', outcome, ...(errorCode ? { errorCode } : {}) })
  }
}

/** Report an uncaught renderer error. Main scrubs it and sends it only with Crash reports on. */
export function installRendererErrorReporting(target: Window = window): void {
  const report = (error: unknown): void => {
    const reportError = bridge()?.reportError
    if (!reportError) return
    const value =
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { name: 'Error', message: String(error) }
    try {
      reportError(value)
    } catch {
      /* reporting must never throw */
    }
  }
  target.addEventListener('error', (event) => report(event.error ?? event.message))
  target.addEventListener('unhandledrejection', (event) => report(event.reason))
}
