import { describe, expect, it } from 'vitest'
import { clickWithFallback, isActionabilityTimeout } from '../browser-playwright-actions'
import type { PlaywrightToolResult, SemanticPageSession } from '../playwright-mcp-session'

// Found live: on an unattended Mac the browser drew no frames, and every trusted click on a
// plain radio button waited out its timeout. Nanobrowser falls back to an in-page click.

const STALLED: PlaywrightToolResult = {
  isError: true,
  text: '### Error\nTimeoutError: browserBackend.callTool: Timeout 10000ms exceeded.\nCall log:\n  - attempting click action\n    - waiting for element to be visible, enabled and stable'
}

function session(
  answers: Record<string, PlaywrightToolResult>,
  calls: string[]
): SemanticPageSession {
  return {
    snapshot: async () => ({ text: '', isError: false }),
    recoverPage: async () => ({ text: '', isError: false }),
    call: async (name: string, args: Record<string, unknown>) => {
      calls.push(`${name}:${String(args.target)}`)
      return answers[name] ?? { text: 'ok', isError: false }
    }
  }
}

describe('clickWithFallback', () => {
  it('clicks in the page when the trusted click cannot prove the element stable', async () => {
    const calls: string[] = []
    const result = await clickWithFallback(session({ browser_click: STALLED }, calls), {
      element: 'Medium',
      target: 'e19'
    })
    expect(result).toEqual({ text: 'Clicked Medium in the page.', isError: false })
    expect(calls).toEqual(['browser_click:e19', 'browser_evaluate:e19'])
  })

  it('keeps a trusted click that worked, or failed for another reason', async () => {
    const calls: string[] = []
    expect(
      (await clickWithFallback(session({}, calls), { element: 'Go', target: 'e1' })).isError
    ).toBe(false)
    const stale = { isError: true, text: 'Ref e9 not found in the current page snapshot.' }
    expect(
      await clickWithFallback(session({ browser_click: stale }, calls), {
        element: 'X',
        target: 'e9'
      })
    ).toEqual(stale)
    expect(calls).toEqual(['browser_click:e1', 'browser_click:e9'])
  })

  it('reports the trusted error when the in-page click also fails', async () => {
    const calls: string[] = []
    const result = await clickWithFallback(
      session({ browser_click: STALLED, browser_evaluate: { isError: true, text: 'nope' } }, calls),
      { element: 'Medium', target: 'e19' }
    )
    expect(result).toEqual(STALLED)
    expect(isActionabilityTimeout(STALLED)).toBe(true)
  })
})
