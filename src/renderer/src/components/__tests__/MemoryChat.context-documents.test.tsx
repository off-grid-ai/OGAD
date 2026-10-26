// @vitest-environment jsdom
//
// A chat given documents by its host (a meeting's chat on the Meetings screen): it starts on a new
// chat rather than the last one open, every turn reads the documents,
// and a cited passage of one is shown by the host, with the answer that cited it.
//
// Drives the REAL <MemoryChat/>: the window.api bridge to MAIN is the only fake. What MAIN
// receives (toolChat's documents) and what the user sees and clicks are the terminal artifacts.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryChat } from '../MemoryChat'
import { TooltipProvider } from '../ui/tooltip'

type StreamEvent = { streamId: string; type: 'content'; text?: string }

const MEETING_TEXT =
  'Meeting: Pricing review\n\nTranscript:\n[0:00] Priya: Hello.\n[1:05] Dev: The pilot costs $40k.'

function installApi(): { toolChat: ReturnType<typeof vi.fn> } {
  let streamCb: ((e: StreamEvent) => void) | null = null
  let nextMessageId = 0
  const toolChat = vi.fn(async (..._args: unknown[]) => {
    const streamId = (_args[2] as { streamId: string }).streamId
    streamCb?.({ streamId, type: 'content', text: 'The pilot costs $40k [S1].' })
    return {
      answer: 'The pilot costs $40k [S1].',
      toolCalls: [{ name: 'search_memory', result: 'Read 1 document', status: 'completed' }],
      // An answer from before the document had its id: the citation names the old fingerprint.
      unified: [
        {
          key: 'attachment:oldfingerprint:1:1',
          kind: 'attachment',
          refId: 0,
          title: 'Meeting: Pricing review · part 2',
          snippet: '[1:05] Dev: The pilot costs $40k.',
          surface: 'Meeting: Pricing review',
          url: null,
          ts: 0,
          imagePath: null,
          score: 1
        }
      ]
    }
  })
  const api = {
    isPro: false,
    imageGenStatus: vi.fn(async () => ({ available: false, models: [], active: '' })),
    cancelImageGen: vi.fn(),
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
    // Chat already holds another conversation: a meeting's chat must not open it.
    getRagConversations: vi.fn(async () => [
      { id: 'elsewhere', title: 'Weekend plans', project_id: null, updated_at: '2026-10-01' },
      { id: 'about-meeting', title: 'Pilot pricing', project_id: null, updated_at: '2026-10-02' }
    ]),
    getRagConversation: vi.fn(async () => ({ id: 'elsewhere', project_id: null })),
    getRagMessages: vi.fn(async () => [
      { id: 1, role: 'user', content: 'Where should we hike?', created_at: '2026-10-01' }
    ]),
    createRagConversation: vi.fn(async () => {}),
    addRagMessage: vi.fn(async () => {
      nextMessageId += 1
      return { id: nextMessageId, uuid: `context-message-${nextMessageId}` }
    }),
    saveArtifact: vi.fn(async () => {}),
    getSettings: vi.fn(async () => ({})),
    saveSetting: vi.fn(async () => {}),
    listProjects: vi.fn(async () => []),
    styleThumbs: vi.fn(async () => ({})),
    listSkills: vi.fn(async () => []),
    // A pane can pick its own remote model: no model servers here.
    getRemoteVisionServer: vi.fn(async () => ({ servers: [] })),
    documents: {
      list: async (): Promise<unknown[]> => [],
      setExcluded: async (): Promise<void> => undefined,
      onProgress: (): (() => void) => () => undefined
    },
    filePath: (): string => '',
    onRagStream: vi.fn((cb: (e: StreamEvent) => void) => {
      streamCb = cb
      return () => {}
    }),
    toolChat
  }
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
  return { toolChat }
}

describe('<MemoryChat/> given documents by its host', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  })

  it('starts fresh, reads the documents every turn, and lets the host show a cited passage', async () => {
    const { toolChat } = installApi()
    const opened: [string, string][] = []
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <MemoryChat
          paneKey="meeting-7"
          openTarget={{ fresh: true, draftPrompt: 'What does the pilot cost?' }}
          conversationIds={['about-meeting']}
          contextDocuments={() => [
            {
              id: 'meeting-7-abc',
              name: 'Meeting: Pricing review',
              kind: 'pasted',
              text: MEETING_TEXT,
              onOpen: (passage, answer) => opened.push([passage, answer])
            }
          ]}
        />
      </TooltipProvider>
    )

    const textarea = await screen.findByPlaceholderText(/ask anything/i, {}, { timeout: 3000 })
    // A new chat, not the conversation Chat had open.
    expect(screen.queryByText('Where should we hike?')).toBeNull()

    // A fresh start keeps a draft it was handed.
    await waitFor(() =>
      expect((textarea as HTMLTextAreaElement).value).toBe('What does the pilot cost?')
    )
    await user.click(screen.getByRole('button', { name: /^send$/i }))

    // MAIN reads the meeting as a document on the turn; the click handler stays in the window.
    await waitFor(() => expect(toolChat).toHaveBeenCalled())
    const options = toolChat.mock.calls[0]![2] as { documents?: unknown[] }
    expect(options.documents).toEqual([
      {
        documentId: 'meeting-7-abc',
        name: 'Meeting: Pricing review',
        kind: 'pasted',
        text: MEETING_TEXT
      }
    ])

    // The cited passage is the host's to show, even from an answer that names its old fingerprint.
    await user.click(await screen.findByRole('button', { name: /part 2/ }, { timeout: 3000 }))
    expect(opened).toEqual([['[1:05] Dev: The pilot costs $40k.', 'The pilot costs $40k [S1].']])
  })
})
