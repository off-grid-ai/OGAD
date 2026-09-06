// @vitest-environment jsdom
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createUseApplication, type GateDecision, type SqlDriver } from '@offgrid/use'
import { afterEach, describe, expect, it } from 'vitest'
import { ActionGateDock } from '../ActionGateDock'

const isSqlInputValue = (value: unknown): value is SQLInputValue =>
  value === null ||
  typeof value === 'number' ||
  typeof value === 'bigint' ||
  typeof value === 'string' ||
  ArrayBuffer.isView(value)

/** The SqlDriver contract carries `unknown[]`; node:sqlite binds only SQL scalars. */
const bindable = (params: unknown[]): SQLInputValue[] =>
  params.map((value) => {
    if (!isSqlInputValue(value)) throw new TypeError(`Unbindable SQL parameter: ${String(value)}`)
    return value
  })

const makeDriver = (): SqlDriver => {
  const database = new DatabaseSync(':memory:')
  return {
    async run(sql, params = []) {
      const statement = database.prepare(sql)
      return {
        changes: sql.trimStart().toUpperCase().startsWith('SELECT')
          ? statement.all(...bindable(params)).length
          : Number(statement.run(...bindable(params)).changes)
      }
    },
    async get<T>(sql: string, params: unknown[] = []) {
      const statement = database.prepare(sql)
      return statement.get(...bindable(params)) as T | undefined
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return database.prepare(sql).all(...bindable(params)) as T[]
    }
  }
}

afterEach(cleanup)

describe('<ActionGateDock/> approval recovery', () => {
  it('keeps a failed approval retryable until the retried action completes', async () => {
    let nextId = 0
    let executions = 0
    let sentDecision: { actionId: string; decision: GateDecision } | undefined
    const decisions = new Map<string, (decision: GateDecision) => void>()
    const parked = new Map<string, () => void>()
    const allParked = new Set<() => void>()
    const application = createUseApplication({
      driver: makeDriver(),
      scheduler: {
        every: () => () => undefined,
        after: (delayMs, listener) => {
          const timer = setTimeout(listener, delayMs)
          return () => clearTimeout(timer)
        }
      },
      newId: () => `calendar-action-${++nextId}`,
      park: {
        onParked: (listener) => {
          allParked.add(listener)
          return () => allParked.delete(listener)
        },
        onActionParked: (actionId, listener) => {
          parked.set(actionId, listener)
          return () => parked.delete(actionId)
        }
      },
      gate: ({ action }) =>
        new Promise((resolve) => {
          decisions.set(action.id, resolve)
          parked.get(action.id)?.()
          for (const listener of allParked) listener()
        }),
      device: {
        async execute() {
          executions += 1
          return executions === 1
            ? { ok: false, detail: 'The destination rejected the change.' }
            : { ok: true, effectId: 'calendar:event-1' }
        }
      },
      handlers: [
        {
          type: 'calendar',
          rail: 'semantic',
          defaultRisk: 'irreversible',
          verification: 'status',
          verify: async () => executions > 1
        }
      ]
    })
    window.api = {
      isPro: false,
      actions: {
        getProjection: async () => application.snapshot(),
        onProjection: (listener) => application.subscribe(listener),
        retry: (actionId) => application.retry(actionId).then((value) => ({ ok: true, value })),
        resolveGate: async (actionId, decision) => {
          sentDecision = { actionId, decision: decision as GateDecision }
          return true
        },
        undo: async () => ({ ok: false })
      }
    } as never

    const driveUntil = async (condition: () => boolean): Promise<void> => {
      for (let turn = 0; turn < 100 && !condition(); turn += 1) {
        await act(async () => {
          await new Promise((resolve) => setImmediate(resolve))
          application.kick()
        })
      }
      expect(condition()).toBe(true)
    }
    const proposed = await application.run({
      proposal: {
        type: 'calendar',
        intent: 'Update the release calendar',
        args: { date: 'September 8' },
        risk: 'irreversible'
      },
      source: 'chat',
      sourceRef: 'conversation-a'
    })
    expect(proposed.accepted).toBe(true)
    await driveUntil(() => decisions.size === 1)

    const user = userEvent.setup()
    render(<ActionGateDock conversationId="conversation-a" />)
    expect(await screen.findByText('Approval needed')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(screen.getByText('Approval needed')).toBeTruthy()
    await act(async () => {
      const sent = sentDecision
      if (!sent) throw new Error('approval intent was not sent')
      decisions.get(sent.actionId)?.(sent.decision)
      decisions.delete(sent.actionId)
    })
    await driveUntil(() => application.snapshot().recoverable.length === 1)
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.getByText(/destination rejected the change/i)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await driveUntil(() => decisions.size === 1)
    expect(await screen.findByText('Approval needed')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await act(async () => {
      const sent = sentDecision
      if (!sent) throw new Error('approval intent was not sent')
      decisions.get(sent.actionId)?.(sent.decision)
      decisions.delete(sent.actionId)
    })
    await driveUntil(() => executions === 2 && application.snapshot().active.length === 0)
    expect(screen.queryByText('Approval needed')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(executions).toBe(2)
    await application.stop()
  })
})
