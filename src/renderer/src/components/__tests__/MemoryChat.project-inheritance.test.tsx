// @vitest-environment jsdom
//
// RELEASE_TEST_CHECKLIST #54 - starting a chat from a project must file the
// conversation under that project and keep the same project as its knowledge scope.
//
// This mounts the real MemoryChat and drives its real composer. Electron IPC and the
// model runtime cannot run in jsdom, so the preload bridge is the only fake boundary.
// The terminal artifacts are the two payloads that cross that boundary:
// createRagConversation persists project_id in the main-process SQLite store, and
// ragChat uses that same project id for document retrieval. The SQLite round-trip
// behind createRagConversation is covered by database-integration.dbtest.ts.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryChat } from '../MemoryChat'
import { TooltipProvider } from '../ui/tooltip'

type CreateConversationArgs = [id: string, title?: string, projectId?: string | null]
type RagChatArgs = [
  query: string,
  appName?: string,
  history?: { role: string; content: string }[],
  projectId?: string | null,
  conversationId?: string,
  noMemory?: boolean,
  streamId?: string,
  thinking?: boolean,
  images?: string[]
]
type ConversationRecord = {
  id: string
  title: string
  project_id: string
  created_at: string
  updated_at: string
  message_count: number
}

function installApi(
  project: { id: string; name: string },
  existingConversation?: ConversationRecord
): {
  createRagConversation: ReturnType<typeof vi.fn>
  ragChat: ReturnType<typeof vi.fn>
} {
  const createRagConversation = vi.fn(async (..._args: CreateConversationArgs) => '')
  const ragChat = vi.fn(async (..._args: RagChatArgs) => ({
    answer: 'The project plan is in scope.',
    context: { unified: [] }
  }))
  const api = {
    isPro: false,
    imageGenStatus: vi.fn(async () => ({ available: false, models: [], active: '' })),
    onImageGenProgress: vi.fn(() => () => {}),
    onRagStream: vi.fn(() => () => {}),
    getRagConversations: vi.fn(async () => (existingConversation ? [existingConversation] : [])),
    getRagConversation: vi.fn(async (id: string) =>
      existingConversation?.id === id ? existingConversation : null
    ),
    getRagMessages: vi.fn(async () => []),
    createRagConversation,
    addRagMessage: vi.fn(async () => 1),
    saveArtifact: vi.fn(async () => ''),
    getSettings: vi.fn(async () => ({})),
    saveSetting: vi.fn(async () => {}),
    listProjects: vi.fn(async () => [project]),
    styleThumbs: vi.fn(async () => ({})),
    listSkills: vi.fn(async () => []),
    ragChat
  }
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
  return { createRagConversation, ragChat }
}

describe('<MemoryChat/> - new chat inherits its project (#54)', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  })

  it('uses the project target for both conversation persistence and RAG scope', async () => {
    const project = { id: 'project-launch', name: 'Launch plan' }
    const { createRagConversation, ragChat } = installApi(project)
    const user = userEvent.setup()

    render(
      <TooltipProvider>
        <MemoryChat openTarget={{ projectId: project.id }} />
      </TooltipProvider>
    )

    // Observable precondition: the project selected in Projects is now the active
    // scope shown by the real chat composer.
    expect(await screen.findByText(project.name)).toBeTruthy()

    const textarea = screen.getByPlaceholderText(/ask about .*launch plan/i)
    fireEvent.change(textarea, { target: { value: 'What is the launch date?' } })
    await user.click(screen.getByRole('button', { name: /^send$/i }))

    await waitFor(() => expect(createRagConversation).toHaveBeenCalledTimes(1))
    const [conversationId, title, persistedProjectId] = createRagConversation.mock.calls[0]!
    // A fresh id was minted for this conversation rather than an existing one reused. It is a UUID now
    // (crypto.randomUUID) instead of the old rag- prefix, because the id has to be unique across every
    // device that syncs the conversation, not just within one Mac's table.
    expect(conversationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(title).toBe('What is the launch date?')
    expect(persistedProjectId).toBe(project.id)

    await waitFor(() => expect(ragChat).toHaveBeenCalledTimes(1))
    const ragArgs = ragChat.mock.calls[0]!
    expect(ragArgs[0]).toBe('What is the launch date?')
    expect(ragArgs[3]).toBe(project.id)
    expect(ragArgs[4]).toBe(conversationId)
    expect(ragArgs[5]).toBe(false)
  })

  it('restores the saved project when the conversation is reopened', async () => {
    const project = { id: 'project-launch', name: 'Launch plan' }
    const conversation = {
      id: 'conversation-launch',
      title: 'Launch date',
      project_id: project.id,
      created_at: '2026-07-17T00:00:00.000Z',
      updated_at: '2026-07-17T00:00:00.000Z',
      message_count: 0
    }
    const { createRagConversation, ragChat } = installApi(project, conversation)
    const user = userEvent.setup()

    render(
      <TooltipProvider>
        <MemoryChat openTarget={{ conversationId: conversation.id }} />
      </TooltipProvider>
    )

    expect(await screen.findByText(project.name)).toBeTruthy()
    const textarea = screen.getByPlaceholderText(/ask about .*launch plan/i)
    fireEvent.change(textarea, { target: { value: 'What changed?' } })
    await user.click(screen.getByRole('button', { name: /^send$/i }))

    await waitFor(() => expect(ragChat).toHaveBeenCalledTimes(1))
    expect(createRagConversation).not.toHaveBeenCalled()
    const ragArgs = ragChat.mock.calls[0]!
    expect(ragArgs[3]).toBe(project.id)
    expect(ragArgs[4]).toBe(conversation.id)
    expect(ragArgs[5]).toBe(false)
  })
})
