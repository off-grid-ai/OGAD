/**
 * Durable conversation changes through the production Desktop-to-renderer boundary. Electron
 * BrowserWindows are the only external-process fake; the published payload stays production-real.
 */
import { describe, expect, it, vi } from 'vitest'

const delivered: Array<{ window: string; channel: string; payload: unknown }> = []
const windows = ['main', 'overlay'].map((window) => ({
  webContents: {
    send: (channel: string, payload: unknown) => delivered.push({ window, channel, payload })
  }
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => windows }
}))

const { notifyRagConversationChanged } = await import('../rag-conversation-events')

describe('RAG conversation change notification', () => {
  it('publishes the exact durable identity to every Desktop renderer', () => {
    notifyRagConversationChanged({ conversationId: 'chat-aurora', projectId: 'project-release' })
    notifyRagConversationChanged({ conversationId: 'chat-inbox' })

    expect(delivered).toEqual([
      {
        window: 'main',
        channel: 'rag:conversations-changed',
        payload: { conversationId: 'chat-aurora', projectId: 'project-release' }
      },
      {
        window: 'overlay',
        channel: 'rag:conversations-changed',
        payload: { conversationId: 'chat-aurora', projectId: 'project-release' }
      },
      {
        window: 'main',
        channel: 'rag:conversations-changed',
        payload: { conversationId: 'chat-inbox' }
      },
      {
        window: 'overlay',
        channel: 'rag:conversations-changed',
        payload: { conversationId: 'chat-inbox' }
      }
    ])
  })
})
