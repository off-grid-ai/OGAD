import { describe, expect, it } from 'vitest'
import { registerTaskGuideIpc, type TaskGuideIpcBoundary } from '../task-guide-ipc'

describe('task guide IPC boundary', () => {
  it('routes availability and guide requests, and answers an invalid task id or input without calling the commands', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const ipc: TaskGuideIpcBoundary = { handle: (channel, handler) => void handlers.set(channel, handler) }
    const calls: string[] = []
    registerTaskGuideIpc(ipc, {
      availability: (taskId) => {
        calls.push(`availability:${taskId}`)
        return { available: true }
      },
      guide: async (taskId, input) => {
        calls.push(`guide:${taskId}:${JSON.stringify(input)}`)
        return { kind: 'guided' } as never
      }
    })
    expect([...handlers.keys()].sort()).toEqual(['tasks:guide', 'tasks:guide-availability'])
    expect(await handlers.get('tasks:guide-availability')!({}, 't1')).toEqual({ available: true })
    expect(await handlers.get('tasks:guide-availability')!({}, 42)).toEqual({
      available: false,
      reason: 'This task is no longer available.'
    })
    expect(await handlers.get('tasks:guide')!({}, 't1', { question: 'q' })).toEqual({ kind: 'guided' })
    expect(await handlers.get('tasks:guide')!({}, 't1', null)).toEqual({
      available: false,
      reason: 'This task is no longer available.'
    })
    expect(calls).toEqual(['availability:t1', 'guide:t1:{"question":"q"}'])
  })
})
