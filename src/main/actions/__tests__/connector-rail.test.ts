import { describe, expect, it } from 'vitest'
import { connectorActionArgs, makeConnectorRailExecutor } from '../connector-rail'
import type { ActionRecord } from '@offgrid/use'

const action = (args: Record<string, unknown>): ActionRecord =>
  ({ id: 'a1', type: 'connector', args } as unknown as ActionRecord)

describe('connector rail adapter', () => {
  it('accepts only a positive connector id, a named tool, and an object of args', () => {
    expect(connectorActionArgs({ connectorId: 3, tool: 'send', args: { to: 'x' } })).toEqual({
      connectorId: 3,
      tool: 'send',
      args: { to: 'x' }
    })
    expect(connectorActionArgs({ connectorId: 0, tool: 'send', args: {} })).toBeNull()
    expect(connectorActionArgs({ connectorId: 1.5, tool: 'send', args: {} })).toBeNull()
    expect(connectorActionArgs({ connectorId: 1, tool: '  ', args: {} })).toBeNull()
    expect(connectorActionArgs({ connectorId: 1, tool: 'send', args: [] })).toBeNull()
    expect(connectorActionArgs({ connectorId: 1, tool: 'send', args: null })).toBeNull()
  })

  it('refuses an invalid payload before calling the connector', async () => {
    let calls = 0
    const run = makeConnectorRailExecutor(async () => {
      calls++
      return { ok: true }
    })
    expect(await run(action({ connectorId: -1, tool: 'send', args: {} }))).toEqual({
      ok: false,
      detail: 'invalid connector action payload'
    })
    expect(calls).toBe(0)
  })

  it('reports the connector result as detail: strings as-is, objects as JSON, nothing as a sentence, long output truncated', async () => {
    const results: unknown[] = ['done', { id: 7 }, undefined, 'x'.repeat(9_000)]
    const run = makeConnectorRailExecutor(async () => ({ ok: true, result: results.shift() }))
    const record = action({ connectorId: 1, tool: 'send', args: {} })
    expect(await run(record)).toEqual({ ok: true, detail: 'done' })
    expect(await run(record)).toEqual({ ok: true, detail: '{"id":7}' })
    expect(await run(record)).toEqual({ ok: true, detail: 'Connector action completed.' })
    const long = await run(record)
    expect(long.ok).toBe(true)
    expect(long.detail.endsWith('… (truncated)')).toBe(true)
    expect(long.detail.length).toBeLessThan(8_100)
  })

  it('surfaces a connector refusal and a thrown transport error as failed results', async () => {
    const refused = makeConnectorRailExecutor(async () => ({ ok: false, error: 'rate limited' }))
    expect(await refused(action({ connectorId: 1, tool: 't', args: {} }))).toEqual({ ok: false, detail: 'rate limited' })
    const silent = makeConnectorRailExecutor(async () => ({ ok: false }))
    expect(await silent(action({ connectorId: 1, tool: 't', args: {} }))).toEqual({ ok: false, detail: 'connector call failed' })
    const throwing = makeConnectorRailExecutor(async () => {
      throw new Error('socket hang up')
    })
    expect(await throwing(action({ connectorId: 1, tool: 't', args: {} }))).toEqual({
      ok: false,
      detail: 'connector rail failed: socket hang up'
    })
  })
})
