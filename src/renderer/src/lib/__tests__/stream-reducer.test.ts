import { describe, it, expect } from 'vitest'
import { applyStreamEvent, hasLiveStreamActivity, type StreamedMessage } from '../stream-reducer'

describe('applyStreamEvent', () => {
  it('appends content deltas and clears activity', () => {
    const r = applyStreamEvent(
      { content: 'Hel', activity: { kind: 'running_tool', name: 'x' } },
      { type: 'content', text: 'lo' }
    )
    expect(r.content).toBe('Hello')
    expect(r.activity).toBeUndefined()
  })

  it('appends reasoning deltas', () => {
    expect(applyStreamEvent({ reasoning: 'a' }, { type: 'reasoning', text: 'b' }).reasoning).toBe(
      'ab'
    )
  })

  it('accumulates completed tool calls (live + persisted), in order', () => {
    let m = { toolCalls: [] as { name: string; result: string }[] }
    m = applyStreamEvent(m, {
      type: 'tool_result',
      call: { name: 'web_search', result: 'r1', status: 'completed' }
    })
    m = applyStreamEvent(m, {
      type: 'tool_result',
      call: { name: 'read_url', result: 'r2', status: 'completed' }
    })
    expect(m.toolCalls).toEqual([
      { name: 'web_search', result: 'r1', status: 'completed' },
      { name: 'read_url', result: 'r2', status: 'completed' }
    ])
  })

  it('shows a running tool row on the first step event', () => {
    const r = applyStreamEvent<StreamedMessage>(
      { toolCalls: [{ name: 'web_search', result: 'r1' }] },
      { type: 'step', step: { kind: 'running_tool', name: 'read_url' } }
    )
    expect(r.activity).toEqual({ kind: 'running_tool', name: 'read_url' })
    expect(r.toolCalls).toEqual([
      { name: 'web_search', result: 'r1', status: 'completed' },
      { name: 'read_url', result: '', status: 'running' }
    ])
  })

  it('shows planning activity without creating a fake tool row', () => {
    const r = applyStreamEvent<StreamedMessage>(
      { toolCalls: [] },
      {
        type: 'step',
        step: { kind: 'planning', label: 'Planning next action…' }
      }
    )

    expect(r.activity).toEqual({ kind: 'planning', label: 'Planning next action…' })
    expect(r.toolCalls).toEqual([])
  })

  it('completes the running tool row instead of adding a duplicate', () => {
    const running = applyStreamEvent<StreamedMessage>(
      { toolCalls: [] },
      { type: 'step', step: { kind: 'running_tool', name: 'generate_image' } }
    )
    const completed = applyStreamEvent(running, {
      type: 'tool_result',
      call: { name: 'generate_image', result: 'Image generation started', status: 'completed' }
    })

    expect(completed.toolCalls).toEqual([
      {
        name: 'generate_image',
        result: 'Image generation started',
        status: 'completed'
      }
    ])
    expect(completed.activity).toBeUndefined()
  })

  it('keeps a needs-attention tool result pending instead of marking work complete', () => {
    const running = applyStreamEvent<StreamedMessage>(
      { toolCalls: [] },
      { type: 'step', step: { kind: 'running_tool', name: 'web_use' } }
    )
    const pending = applyStreamEvent(running, {
      type: 'tool_result',
      call: {
        name: 'web_use',
        result: 'Please answer the missing questions.',
        status: 'pending'
      }
    })

    expect(pending.toolCalls).toEqual([
      {
        name: 'web_use',
        result: 'Please answer the missing questions.',
        status: 'pending'
      }
    ])
  })

  it('stops the live indicator after the tool result arrives', () => {
    expect(
      hasLiveStreamActivity({
        toolCalls: [{ name: 'web_use', result: 'Visual decision failed.', status: 'completed' }]
      })
    ).toBe(false)
  })

  it('keeps the live indicator while a tool is running', () => {
    expect(
      hasLiveStreamActivity({
        activity: { kind: 'running_tool' },
        toolCalls: [{ name: 'web_use', result: '', status: 'running' }]
      })
    ).toBe(true)
  })
})
