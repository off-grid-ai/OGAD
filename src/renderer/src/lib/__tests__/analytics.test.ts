// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { analyticsBridge, flow, installRendererErrorReporting, track } from '../analytics'

/**
 * The renderer half of opt-in analytics reaches main only through the preload bridge, which is the
 * process boundary and the one thing stood in for here. Main owns validation and consent.
 */

interface Sent {
  capture: unknown[][]
  flow: unknown[]
  errors: unknown[]
}

function installBridge(): Sent {
  const sent: Sent = { capture: [], flow: [], errors: [] }
  ;(window as unknown as { api: unknown }).api = {
    analytics: {
      capture: (...args: unknown[]) => sent.capture.push(args),
      flow: (report: unknown) => sent.flow.push(report),
      reportError: (report: unknown) => sent.errors.push(report)
    }
  }
  return sent
}

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('renderer analytics', () => {
  it('does nothing where the bridge is absent', () => {
    expect(analyticsBridge()).toBeUndefined()
    expect(() => {
      track('reply_regenerated')
      flow.start('connector_add')
    }).not.toThrow()
  })

  it('forwards events and flows to main', () => {
    const sent = installBridge()
    track('feature_used', { feature: 'tts' })
    track('problem_reported')
    flow.start('pro_upgrade')
    flow.step('pro_upgrade', 'gate_shown', 'meetings')
    flow.step('remote_server', 'opened')
    flow.finish('connector_add', 'failed', 'connect_failed')
    flow.finish('connector_add', 'done')
    expect(sent.capture).toEqual([
      ['feature_used', { feature: 'tts' }],
      ['problem_reported', undefined]
    ])
    expect(sent.flow).toEqual([
      { flow: 'pro_upgrade', action: 'start' },
      { flow: 'pro_upgrade', action: 'step', step: 'gate_shown', detail: 'meetings' },
      { flow: 'remote_server', action: 'step', step: 'opened' },
      { flow: 'connector_add', action: 'finish', outcome: 'failed', errorCode: 'connect_failed' },
      { flow: 'connector_add', action: 'finish', outcome: 'done' }
    ])
  })

  it('reports uncaught errors and rejections to main for scrubbing', () => {
    const sent = installBridge()
    installRendererErrorReporting(window)
    const error = new TypeError('broke')
    window.dispatchEvent(new ErrorEvent('error', { error, message: 'broke' }))
    window.dispatchEvent(new ErrorEvent('error', { message: 'only a message' }))
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown }
    rejection.reason = 'plain reason'
    window.dispatchEvent(rejection)
    expect(sent.errors).toEqual([
      { name: 'TypeError', message: 'broke', stack: error.stack },
      { name: 'Error', message: 'only a message' },
      { name: 'Error', message: 'plain reason' }
    ])
  })
})
