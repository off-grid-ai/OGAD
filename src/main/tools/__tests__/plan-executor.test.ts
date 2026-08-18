/**
 * The plan executor: runs steps through the injected dispatcher in order,
 * threads a resolved value from one step into the next (contacts -> message),
 * merges sources/imageRequest like the reactive loop, and halts (never
 * dispatches) when a required binding can't be resolved.
 */
import { describe, expect, it, vi } from 'vitest'
import { makePlanExecutor, applyBindings, type DispatchResult } from '../plan-executor'
import type { Plan } from '../planner-logic'

const R = (text: string, extra: Partial<DispatchResult> = {}): DispatchResult => ({ text, ...extra })

describe('applyBindings', () => {
  it('fills an arg from an earlier contacts result', () => {
    const step = { tool: 'messages_send', args: { text: 'hi' }, why: '', bindings: [{ arg: 'to', fromStep: 0, field: 'phone' }] }
    const args = applyBindings(step, [JSON.stringify([{ name: 'Sidd', phone: '+15550000' }])])
    expect(args).toEqual({ text: 'hi', to: '+15550000' })
  })

  it('returns null when the source is missing or unresolvable (halt, do not send blank)', () => {
    const step = { tool: 'messages_send', args: { text: 'hi' }, why: '', bindings: [{ arg: 'to', fromStep: 0, field: 'phone' }] }
    expect(applyBindings(step, [])).toBeNull()
    expect(applyBindings(step, [JSON.stringify([{ name: 'nobody' }])])).toBeNull()
  })
})

describe('makePlanExecutor', () => {
  it('runs a single web_task step and reports it', async () => {
    const dispatch = vi.fn(async () => R('opened youtube and played the video'))
    const exec = makePlanExecutor(dispatch)
    const plan: Plan = {
      steps: [{ tool: 'web_task', args: { goal: 'play X', url: 'https://youtube.com' }, why: 'interactive', bindings: [] }]
    }
    const result = await exec(plan)
    expect(dispatch).toHaveBeenCalledWith('web_task', { goal: 'play X', url: 'https://youtube.com' })
    expect(result.toolCalls).toHaveLength(1)
    expect(result.stopped).toBeUndefined()
  })

  it('threads contacts_search -> messages_send (the recipient binding)', async () => {
    const dispatch = vi.fn(async (name: string) =>
      name === 'contacts_search'
        ? R(JSON.stringify([{ name: 'Dishit', phone: '+15551111' }]))
        : R('Sent the message.')
    )
    const exec = makePlanExecutor(dispatch)
    const plan: Plan = {
      steps: [
        { tool: 'contacts_search', args: { query: 'Dishit' }, why: 'resolve recipient', bindings: [] },
        { tool: 'messages_send', args: { text: 'hi' }, why: 'send', bindings: [{ arg: 'to', fromStep: 0, field: 'phone' }] }
      ]
    }
    const result = await exec(plan)
    expect(dispatch).toHaveBeenNthCalledWith(2, 'messages_send', { text: 'hi', to: '+15551111' })
    expect(result.toolCalls).toHaveLength(2)
  })

  it('halts before the send when the contact cannot be resolved', async () => {
    const dispatch = vi.fn(async () => R(JSON.stringify([{ name: 'nobody' }])))
    const exec = makePlanExecutor(dispatch)
    const plan: Plan = {
      steps: [
        { tool: 'contacts_search', args: { query: 'ghost' }, why: '', bindings: [] },
        { tool: 'messages_send', args: { text: 'hi' }, why: '', bindings: [{ arg: 'to', fromStep: 0, field: 'phone' }] }
      ]
    }
    const result = await exec(plan)
    expect(dispatch).toHaveBeenCalledTimes(1) // only contacts_search ran; the send was NOT dispatched
    expect(result.stopped).toMatch(/could not resolve/i)
  })

  it('merges sources and imageRequest across steps', async () => {
    const dispatch = vi.fn(async (name: string) =>
      name === 'a'
        ? R('x', { sources: [{ key: 's1' } as never] })
        : R('y', { sources: [{ key: 's1' } as never, { key: 's2' } as never], imageRequest: { prompt: 'p' } })
    )
    const exec = makePlanExecutor(dispatch)
    const plan: Plan = {
      steps: [
        { tool: 'a', args: {}, why: '', bindings: [] },
        { tool: 'b', args: {}, why: '', bindings: [] }
      ]
    }
    const result = await exec(plan)
    expect(result.unified.map((s) => s.key)).toEqual(['s1', 's2']) // deduped
    expect(result.imageRequest).toEqual({ prompt: 'p' })
  })
})
