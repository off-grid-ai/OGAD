// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryChat } from '../MemoryChat'
import { TooltipProvider } from '../ui/tooltip'

type StoredMessage = {
  id: number
  uuid: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  context: {
    attachments?: Array<{ name: string; kind: string; text?: string; path?: string }>
  } | null
  created_at: string
}

function installSavedVoiceBoundary(): void {
  const conversation = {
    id: 'saved-voice-chat',
    title: 'Saved voice chat',
    project_id: null,
    created_at: '2026-09-14 10:00:00',
    updated_at: '2026-09-14 10:00:00',
    message_count: 2
  }
  let messages: StoredMessage[] = [
    {
      id: 1,
      uuid: 'saved-voice-message',
      conversation_id: conversation.id,
      role: 'user',
      content: 'Original transcript',
      context: {
        attachments: [
          {
            name: 'saved-voice.m4a',
            kind: 'audio',
            text: 'Original transcript',
            path: '/saved/saved-voice.m4a'
          }
        ]
      },
      created_at: '2026-09-14 10:00:00'
    },
    {
      id: 2,
      uuid: 'later-answer',
      conversation_id: conversation.id,
      role: 'assistant',
      content: 'Later answer stays',
      context: null,
      created_at: '2026-09-14 10:00:01'
    }
  ]
  let nextId = 3
  const api = {
    isPro: false,
    imageGenStatus: async () => ({ available: false, models: [], active: '' }),
    onImageGenProgress: () => () => { },
    getRagConversations: async () => [{ ...conversation }],
    getRagConversation: async () => ({ ...conversation }),
    getRagMessages: async () => messages.map((message) => ({ ...message })),
    getActiveRagStreams: async () => [],
    onRagStream: () => () => { },
    onRagConversationsChanged: () => () => { },
    addRagMessage: async (
      conversationId: string,
      role: 'user' | 'assistant',
      content: string,
      context?: StoredMessage['context']
    ) => {
      const id = nextId++
      const uuid = `saved-voice-${id}`
      messages.push({
        id,
        uuid,
        conversation_id: conversationId,
        role,
        content,
        context: context ?? null,
        created_at: `2026-09-14 10:00:0${id}`
      })
      return { id, uuid }
    },
    updateRagMessage: async (
      conversationId: string,
      messageId: string,
      content: string,
      context?: StoredMessage['context']
    ) => {
      const index = messages.findIndex(
        (message) =>
          message.conversation_id === conversationId &&
          (message.uuid === messageId || String(message.id) === messageId)
      )
      if (index < 0) return false
      messages[index] = {
        ...messages[index]!,
        content,
        context: context === undefined ? messages[index]!.context : context
      }
      return true
    },
    truncateRagMessages: async (_conversationId: string, keepCount: number) => {
      messages = messages.slice(0, keepCount)
      return 0
    },
    getSettings: async () => ({ composerVoiceMode: true, composerToolsOn: false }),
    saveSetting: async () => { },
    getLlmSettings: async () => ({ ctxSize: 4096 }),
    listTools: async () => [],
    mcpList: async () => [],
    listProjects: async () => [],
    listSkills: async () => [],
    styleThumbs: async () => ({}),
    ttsVoices: async () => [],
    onTtsVoiceProgress: () => () => { },
    prepareTtsVoice: async () => ({ ready: true }),
    speak: async () => ({ dataUrl: 'data:audio/wav;base64,YXVkaW8=' }),
    transcribeAudio: async () => 'Corrected transcript',
    tasks: { list: async () => [], onChanged: () => () => { } },
    ragChat: async () => ({ answer: 'Edited answer', unified: [] })
  }
    ; (window as unknown as { api: unknown }).api = api
}

function renderSavedVoiceChat(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <MemoryChat openTarget={{ conversationId: 'saved-voice-chat' }} />
    </TooltipProvider>
  )
}

const originalFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('<MemoryChat/> saved voice actions', () => {
  it('keeps copy and resend in the voice menu and shows the saved message time', async () => {
    ; (Element.prototype as unknown as { scrollIntoView(): void }).scrollIntoView = () => { }
    installSavedVoiceBoundary()

    renderSavedVoiceChat()

    const savedMessageTime = new Date('2026-09-14T10:00:00Z').toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit'
    })
    expect(await screen.findAllByText(savedMessageTime)).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Copy transcript' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Resend' })).toBeNull()

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Voice message actions' }), {
      button: 0,
      ctrlKey: false
    })

    expect(await screen.findByRole('menuitem', { name: 'Copy' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Resend' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Transcribe again' })).toBeTruthy()
  })

  it('transcribes the saved file again, persists it in place, and keeps later messages', async () => {
    ; (Element.prototype as unknown as { scrollIntoView(): void }).scrollIntoView = () => { }
    globalThis.fetch = async () =>
      ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) as Response
    installSavedVoiceBoundary()
    const user = userEvent.setup()
    const chat = renderSavedVoiceChat()

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Voice message actions' }), {
      button: 0,
      ctrlKey: false
    })
    await user.click(await screen.findByRole('menuitem', { name: 'Transcribe again' }))
    await waitFor(() => expect(screen.queryByText('Transcribing...')).toBeNull())
    await user.click(screen.getAllByRole('button', { name: 'Show transcript' })[0]!)
    expect(await screen.findByText('Corrected transcript')).toBeTruthy()

    chat.unmount()
    renderSavedVoiceChat()
    await user.click((await screen.findAllByRole('button', { name: 'Show transcript' }))[0]!)
    expect(await screen.findByText('Corrected transcript')).toBeTruthy()
    expect(screen.getByText('Later answer stays')).toBeTruthy()
  })

  it('opens the existing editor and saves through the normal resend journey', async () => {
    ; (Element.prototype as unknown as { scrollIntoView(): void }).scrollIntoView = () => { }
    globalThis.fetch = async () =>
      ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer }) as Response
    installSavedVoiceBoundary()
    const user = userEvent.setup()
    const chat = renderSavedVoiceChat()

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Voice message actions' }), {
      button: 0,
      ctrlKey: false
    })
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }))
    const editor = await screen.findByDisplayValue('Original transcript')
    await user.clear(editor)
    await user.type(editor, 'Edited voice transcript')
    await user.click(screen.getByRole('button', { name: 'Save & submit' }))

    expect(await screen.findByText('Edited answer')).toBeTruthy()
    chat.unmount()
    renderSavedVoiceChat()
    await user.click((await screen.findAllByRole('button', { name: 'Show transcript' }))[0]!)
    expect(await screen.findByText('Edited voice transcript')).toBeTruthy()
    expect(screen.getByText('Edited answer')).toBeTruthy()
  })

  it('keeps the saved transcript and explains when the audio file is missing', async () => {
    ; (Element.prototype as unknown as { scrollIntoView(): void }).scrollIntoView = () => { }
    globalThis.fetch = async () => ({ ok: false }) as Response
    installSavedVoiceBoundary()
    const user = userEvent.setup()
    renderSavedVoiceChat()

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Voice message actions' }), {
      button: 0,
      ctrlKey: false
    })
    await user.click(await screen.findByRole('menuitem', { name: 'Transcribe again' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'This voice note is not on this Mac.'
    )
    await user.click(screen.getAllByRole('button', { name: 'Show transcript' })[0]!)
    expect(screen.getByText('Original transcript')).toBeTruthy()
  })
})
