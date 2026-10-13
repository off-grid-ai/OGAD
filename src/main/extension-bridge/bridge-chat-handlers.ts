// SHARED VERBATIM with off-grid-ai/browser-extension integration-tests/fixtures/bridge/chat-handlers.ts. Change both.
import {
  AUTOMATION_TASK_CONTROL_INTENTS,
  type AutomationTaskControlIntent as TaskControlIntent
} from '@offgrid/automation'
import { TASK_GUIDE_MAX_TEXT_CHARS as TASK_GUIDE_MAX_CHARS } from '../../shared/task-guidance'
import { parseChatStart, validChatId, type ChatRequest } from './bridge-chat'

const isTaskControlIntent = (v: unknown): v is TaskControlIntent =>
  (AUTOMATION_TASK_CONTROL_INTENTS as readonly unknown[]).includes(v)

type Handler<Browser> = (params: Record<string, unknown>, browser: Browser) => Promise<unknown>
export function chatHandlers<Browser>(
  execute: ((request: ChatRequest, browser: Browser) => Promise<unknown>) | undefined
): Record<
  'chat.start' | 'chat.read' | 'chat.stop' | 'chat.control' | 'chat.guide',
  Handler<Browser>
> {
  const chat = (request: ChatRequest, browser: Browser): Promise<unknown> => {
    if (!execute) {
      throw new Error('chat_unavailable')
    }
    return execute(request, browser)
  }
  return {
    'chat.start': async (p, browser) => {
      const input = parseChatStart(p)
      if (!input) {
        throw new Error('invalid')
      }
      return chat({ action: 'start', input }, browser)
    },
    'chat.read': async (p, browser) => {
      if (!validChatId(p.runId) || !Number.isSafeInteger(p.cursor) || Number(p.cursor) < 0) {
        throw new Error('invalid')
      }
      return chat({ action: 'read', runId: p.runId, cursor: Number(p.cursor) }, browser)
    },
    'chat.stop': async (p, browser) => {
      if (!validChatId(p.runId)) {
        throw new Error('invalid')
      }
      return chat({ action: 'stop', runId: p.runId }, browser)
    },
    'chat.control': async (p, browser) => {
      if (!validChatId(p.runId) || !isTaskControlIntent(p.intent)) {
        throw new Error('invalid')
      }
      return chat({ action: 'control', runId: p.runId, intent: p.intent }, browser)
    },
    'chat.guide': async (p, browser) => {
      const text = typeof p.text === 'string' ? p.text : ''
      if (!validChatId(p.runId) || !text.trim() || text.length > TASK_GUIDE_MAX_CHARS) {
        throw new Error('invalid')
      }
      return chat({ action: 'guide', runId: p.runId, text }, browser)
    }
  }
}
