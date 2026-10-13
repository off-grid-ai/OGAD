import { describe, expect, it } from 'vitest'
import { AUTOMATION_TASK_CONTROL_INTENTS } from '@offgrid/automation'
import { chatHandlers } from '../bridge-chat-handlers'
import { RPC_METHODS } from '../bridge-protocol'
import type { ChatRequest } from '../bridge-chat'

// A browser panel controls its own run's task (Pause, Continue, Resume, Take Over, Stop)
// through chat.control. The intents are the shared automation package's, never a copy.

describe('chat.control', () => {
  it('is a bridge method', () => {
    expect(RPC_METHODS).toContain('chat.control')
  })

  it('passes every shared control intent through for the run', async () => {
    const seen: ChatRequest[] = []
    const handlers = chatHandlers<string>(async (request) => {
      seen.push(request)
      return true
    })
    for (const intent of AUTOMATION_TASK_CONTROL_INTENTS) {
      await expect(handlers['chat.control']({ runId: 'run-12345678', intent }, 'b')).resolves.toBe(
        true
      )
    }
    expect(seen).toEqual(
      AUTOMATION_TASK_CONTROL_INTENTS.map((intent) => ({
        action: 'control',
        runId: 'run-12345678',
        intent
      }))
    )
  })

  it('refuses an unknown intent or a malformed run id before reaching the run', async () => {
    const handlers = chatHandlers<string>(async () => {
      throw new Error('should not run')
    })
    await expect(
      handlers['chat.control']({ runId: 'run-12345678', intent: 'delete' }, 'b')
    ).rejects.toThrow('invalid')
    await expect(handlers['chat.control']({ runId: 'x', intent: 'pause' }, 'b')).rejects.toThrow(
      'invalid'
    )
  })
})

describe('chat.guide', () => {
  it('is a bridge method that passes the text to the run', async () => {
    expect(RPC_METHODS).toContain('chat.guide')
    const seen: ChatRequest[] = []
    const handlers = chatHandlers<string>(async (request) => {
      seen.push(request)
      return { accepted: true, reason: '' }
    })
    await handlers['chat.guide']({ runId: 'run-12345678', text: 'I finished the CAPTCHA.' }, 'b')
    expect(seen).toEqual([
      { action: 'guide', runId: 'run-12345678', text: 'I finished the CAPTCHA.' }
    ])
  })

  it('refuses empty or oversized guidance, or a malformed run id', async () => {
    const handlers = chatHandlers<string>(async () => true)
    for (const params of [
      { runId: 'run-12345678', text: '   ' },
      { runId: 'run-12345678', text: 'x'.repeat(2001) },
      { runId: 'run-12345678' },
      { runId: '../x', text: 'ok' }
    ]) {
      await expect(handlers['chat.guide'](params, 'b')).rejects.toThrow('invalid')
    }
  })
})
