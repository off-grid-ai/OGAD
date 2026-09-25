// @vitest-environment jsdom
//
// RELEASE_TEST_CHECKLIST #54 - starting a chat from a project must file the
// conversation under that project and keep the same project as its knowledge scope.
//
// This mounts the real MemoryChat and drives its real composer. Electron IPC and the
// model runtime cannot run in jsdom, so the preload bridge is the only fake boundary.
// The terminal artifacts are the two payloads that cross that boundary:
// createRagConversation persists project_id in the main-process SQLite store, and
// toolChat uses that same project id for document retrieval. The SQLite round-trip
// behind createRagConversation is covered by database-integration.dbtest.ts.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryChat } from '../MemoryChat'
import { TooltipProvider } from '../ui/tooltip'

type CreateConversationArgs = [id: string, title?: string, projectId?: string | null]
type ToolChatArgs = [
  query: string,
  history: { role: string; content: string }[],
  options: { projectId?: string; conversationId?: string; allMemory?: boolean }
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
  project: { id: string; name: string } | { id: string; name: string }[],
  existingConversation?: ConversationRecord
): {
  createRagConversation: ReturnType<typeof vi.fn>
  toolChat: ReturnType<typeof vi.fn>
} {
  const createRagConversation = vi.fn(async (..._args: CreateConversationArgs) => '')
  const toolChat = vi.fn(async (..._args: ToolChatArgs) => ({
    answer: 'The project plan is in scope.',
    unified: [],
    toolCalls: []
  }))
  const api = {
    isPro: false,
    imageGenStatus: vi.fn(async () => ({ available: false, models: [], active: '' })),
    onImageGenProgress: vi.fn(() => () => {}),
    onImageGenJobState: vi.fn(() => () => {}),
    onImageGenConversationUpdated: vi.fn(() => () => {}),
    imageGenJobStatus: vi.fn(async () => ({
      id: null,
      phase: 'idle' as const,
      conversationId: null,
      projectId: null,
      stage: null,
      enhancedPrompt: '',
      progress: null,
      outputPath: null,
      error: null,
      startedAt: null,
      finishedAt: null
    })),
    onRagStream: vi.fn(() => () => {}),
    getRagConversations: vi.fn(async () => (existingConversation ? [existingConversation] : [])),
    getRagConversation: vi.fn(async (id: string) =>
      existingConversation?.id === id ? existingConversation : null
    ),
    getRagMessages: vi.fn(async () => []),
    createRagConversation,
    addRagMessage: vi.fn(async () => ({ id: 1, uuid: 'project-message-1' })),
    saveArtifact: vi.fn(async () => ''),
    getSettings: vi.fn(async () => ({})),
    getLlmSettings: vi.fn(async () => ({})),
    saveSetting: vi.fn(async () => {}),
    listProjects: vi.fn(async () => (Array.isArray(project) ? project : [project])),
    styleThumbs: vi.fn(async () => ({})),
      listSkills: vi.fn(async () => []),
      toolChat
    }
   ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
  return { createRagConversation, toolChat }
}

describe('<MemoryChat/> - new chat inherits its project (#54)', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  })

  it('uses the project target for both conversation persistence and RAG scope', async () => {
    const project = { id: 'project-launch', name: 'Launch plan' }
    const { createRagConversation, toolChat } = installApi(project)
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
    expect(conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
    expect(title).toBe('What is the launch date?')
    expect(persistedProjectId).toBe(project.id)

    await waitFor(() => expect(toolChat).toHaveBeenCalledTimes(1))
    const toolArgs = toolChat.mock.calls[0]!
    expect(toolArgs[0]).toBe('What is the launch date?')
    expect(toolArgs[2]).toMatchObject({
      projectId: project.id,
      conversationId,
      allMemory: false
    })
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
    const { createRagConversation, toolChat } = installApi(project, conversation)
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

    await waitFor(() => expect(toolChat).toHaveBeenCalledTimes(1))
    expect(createRagConversation).not.toHaveBeenCalled()
    expect(toolChat.mock.calls[0]![2]).toMatchObject({
      projectId: project.id,
      conversationId: conversation.id,
      allMemory: false
    })
  })

  it('keeps the send in its starting project when the selection changes during conversation creation', async () => {
    const startingProject = { id: 'project-launch', name: 'Launch plan' }
    const nextProject = { id: 'project-support', name: 'Support plan' }
    const { createRagConversation, toolChat } = installApi([startingProject, nextProject])
    let finishCreation: (() => void) | undefined
    createRagConversation.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finishCreation = () => resolve('')
        })
    )
    const user = userEvent.setup()

    render(
      <TooltipProvider>
        <MemoryChat openTarget={{ projectId: startingProject.id }} />
      </TooltipProvider>
    )

    const textarea = await screen.findByPlaceholderText(/ask about .*launch plan/i)
    fireEvent.change(textarea, { target: { value: 'What is the launch date?' } })
    await user.click(screen.getByRole('button', { name: /^send$/i }))
    await waitFor(() => expect(createRagConversation).toHaveBeenCalledTimes(1))

    const scopeButton = screen.getByTitle(/choose what this chat can draw on/i)
    scopeButton.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(scopeButton.getAttribute('data-state')).toBe('open'))
    await user.click(await screen.findByRole('menuitem', { name: nextProject.name }))
    expect(await screen.findByPlaceholderText(/ask about .*support plan/i)).toBeTruthy()

    finishCreation?.()
    await waitFor(() => expect(toolChat).toHaveBeenCalledTimes(1))
    expect(createRagConversation.mock.calls[0]?.[2]).toBe(startingProject.id)
    expect(toolChat.mock.calls[0]?.[2].projectId).toBe(startingProject.id)
  })
})
