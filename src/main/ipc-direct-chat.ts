import {
  buildArtifactGenerationPrompt,
  buildImagePromptEnhancementRequest,
  buildNoMemoryChatMessages,
  formatDeferredImageAnswer,
  type ChatIntent,
  type GenerationMessage
} from '@offgrid/models'
import { generateDesktopText } from './desktop-generation'

type StreamSender = { send: (channel: string, payload: unknown) => void }

export async function answerDirectChatIntent<T>(input: {
  sender: StreamSender
  intent: ChatIntent['intent']
  query: string
  history?: { role: string; content: string }[]
  urls: readonly string[]
  streamId?: string
  noMemory?: boolean
  stream: (prompt: string | readonly GenerationMessage[]) => Promise<T>
}): Promise<(T & { context: undefined }) | { answer: string; context: undefined } | undefined> {
  if (input.intent === 'image') {
    const prompt = buildImagePromptEnhancementRequest(input.query)
    const description = (await generateDesktopText(prompt, { profile: 'prompt-enhancement' }))
      .content
    return { answer: formatDeferredImageAnswer(description, input.query), context: undefined }
  }
  if (input.intent === 'build') {
    const references: { url: string; content?: string; error?: string }[] = []
    if (input.urls.length && input.streamId) {
      input.sender.send('rag:stream', {
        streamId: input.streamId,
        type: 'step',
        step: { kind: 'reading', counts: { urls: input.urls.length } }
      })
    }
    const { readUrlText } = await import('./tools')
    for (const url of input.urls) {
      try {
        references.push({ url, content: await readUrlText(url) })
      } catch (error) {
        references.push({ url, error: (error as Error).message })
      }
    }
    const completion = await input.stream(
      buildArtifactGenerationPrompt({ query: input.query, history: input.history, references })
    )
    return { ...completion, context: undefined }
  }
  if (input.noMemory) {
    const completion = await input.stream(
      buildNoMemoryChatMessages({ query: input.query, history: input.history })
    )
    return { ...completion, context: undefined }
  }
  return undefined
}
