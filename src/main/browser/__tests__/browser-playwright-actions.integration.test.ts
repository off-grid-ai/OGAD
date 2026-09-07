/**
 * Real Web Use action translation through the Desktop adapter. Playwright MCP and Electron pointer
 * projection are external boundaries; the action policy and validation stay in production code.
 */
import { describe, expect, it } from 'vitest'
import type { BrowserDriver } from '../browser-driver'
import type { SemanticDecision } from '../browser-playwright-policy'
import { executePlaywrightAction, projectPlaywrightPointer } from '../browser-playwright-actions'
import type { PlaywrightMcpSession, PlaywrightToolResult } from '../playwright-mcp-session'

function decision(overrides: Partial<SemanticDecision>): SemanticDecision {
  return {
    action: 'click',
    phase_id: null,
    element: 'Continue',
    ref: 'button-12',
    text: null,
    key: null,
    values: null,
    start_element: null,
    start_ref: null,
    end_element: null,
    end_ref: null,
    url: null,
    evidence_ref: null,
    evidence_text: null,
    reason: 'Continue the task',
    summary: 'Click Continue',
    ...overrides
  }
}

describe('Desktop Playwright action adapter', () => {
  it('translates the complete interactive journey into the Playwright MCP contract', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown>; signal?: AbortSignal }> = []
    const session = {
      call: async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
        calls.push({ name, args, signal })
        return { text: 'Action complete', isError: false } satisfies PlaywrightToolResult
      }
    } as PlaywrightMcpSession
    const signal = new AbortController().signal

    await executePlaywrightAction(session, decision({}), signal)
    await executePlaywrightAction(
      session,
      decision({ action: 'type', element: 'Search', ref: 'input-3', text: 'private notes' })
    )
    await executePlaywrightAction(session, decision({ action: 'press_key', key: 'Enter' }))
    await executePlaywrightAction(
      session,
      decision({ action: 'select_option', element: 'Region', ref: 'select-2', values: ['US'] })
    )
    await executePlaywrightAction(
      session,
      decision({
        action: 'drag',
        start_element: 'Card',
        start_ref: 'card-1',
        end_element: 'Done',
        end_ref: 'list-2'
      })
    )
    await executePlaywrightAction(
      session,
      decision({ action: 'navigate', url: 'https://example.com/research?q=off grid' })
    )

    expect(calls).toEqual([
      { name: 'browser_click', args: { element: 'Continue', target: 'button-12' }, signal },
      {
        name: 'browser_type',
        args: {
          element: 'Search',
          target: 'input-3',
          text: 'private notes',
          submit: false,
          slowly: false
        },
        signal: undefined
      },
      { name: 'browser_press_key', args: { key: 'Enter' }, signal: undefined },
      {
        name: 'browser_select_option',
        args: { element: 'Region', target: 'select-2', values: ['US'] },
        signal: undefined
      },
      {
        name: 'browser_drag',
        args: {
          startElement: 'Card',
          startTarget: 'card-1',
          endElement: 'Done',
          endTarget: 'list-2'
        },
        signal: undefined
      },
      {
        name: 'browser_navigate',
        args: { url: 'https://example.com/research?q=off%20grid' },
        signal: undefined
      }
    ])
  })

  it('projects drag targets and rejects incomplete or unsafe decisions before the boundary', async () => {
    const projected: Array<{ ref: string; snapshot: string }> = []
    const driver = {
      projectSemanticTarget: async (ref: string, snapshot: string): Promise<boolean> => {
        projected.push({ ref, snapshot })
        return true
      }
    } as BrowserDriver
    const reached: Array<{ name: string; args: Record<string, unknown>; signal?: AbortSignal }> = []
    const session = {
      call: async (
        name: string,
        args: Record<string, unknown>,
        signal?: AbortSignal
      ): Promise<PlaywrightToolResult> => {
        reached.push({ name, args, signal })
        return { text: '', isError: false }
      }
    } as PlaywrightMcpSession

    await projectPlaywrightPointer(
      driver,
      decision({ action: 'drag', start_ref: 'source-1', end_ref: 'target-2' }),
      'page snapshot'
    )
    await projectPlaywrightPointer(driver, decision({ action: 'hover', ref: 'link-4' }), 'next')

    expect(projected).toEqual([
      { ref: 'source-1', snapshot: 'page snapshot' },
      { ref: 'target-2', snapshot: 'page snapshot' },
      { ref: 'link-4', snapshot: 'next' }
    ])
    await expect(
      executePlaywrightAction(session, decision({ action: 'type', text: '  ' }))
    ).rejects.toThrow('type text is required.')
    await expect(
      executePlaywrightAction(session, decision({ action: 'select_option', values: [] }))
    ).rejects.toThrow('At least one select option is required.')
    await expect(
      executePlaywrightAction(
        session,
        decision({ action: 'navigate', url: 'file:///private/data' })
      )
    ).rejects.toThrow('Web Use navigation accepts only HTTP or HTTPS URLs.')
    await expect(executePlaywrightAction(session, decision({ action: 'done' }))).rejects.toThrow(
      'Web Use cannot execute terminal action done.'
    )
    expect(reached).toEqual([])
  })
})
