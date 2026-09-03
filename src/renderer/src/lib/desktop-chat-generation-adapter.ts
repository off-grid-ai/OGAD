import {
  generatedImagePrompt,
  type GenerationEvents,
  type GenerationMessage,
  type GenerationResult
} from '@offgrid/models'
import type { RagChatResultContract } from '../../../shared/ipc-contracts'
import { subscribeDesktopChatStream } from './desktop-chat-stream-hub'
import {
  desktopHistory,
  desktopImageResult,
  desktopTextResult
} from './desktop-chat-session-policy'
import type {
  DesktopAnyChatSessionInput,
  DesktopChatSessionBoundary,
  DesktopImageChatSessionInput,
  DesktopImageGenerationResponse,
  DesktopToolChatResponse,
  DesktopToolChatSessionInput
} from './desktop-chat-session-contract'

export interface DesktopTurnExecution {
  input: DesktopAnyChatSessionInput
  response?: RagChatResultContract
  toolResponse?: DesktopToolChatResponse
  imageResponse?: DesktopImageGenerationResponse
  generatedImages: DesktopImageGenerationResponse[]
  imageActive: boolean
}

export interface DesktopGenerationContext {
  messages: readonly GenerationMessage[]
  signal: AbortSignal | undefined
  events?: GenerationEvents
}

/** IPC implementation of the one Shared chat-generation port. It owns transport, not route policy. */
export class DesktopChatGenerationAdapter {
  constructor(private readonly boundary: DesktopChatSessionBoundary) {}

  async generate(
    execution: DesktopTurnExecution,
    context: DesktopGenerationContext
  ): Promise<GenerationResult> {
    const { input } = execution
    const unsubscribe = subscribeDesktopChatStream(this.boundary, (event) => {
      if (event.streamId !== input.turnId) return
      if (event.type === 'content' && event.text) context.events?.chunk?.({ content: event.text })
      if (event.type === 'reasoning' && event.text) {
        context.events?.chunk?.({ reasoning: event.text })
      }
      if (event.type === 'route' && event.model) context.events?.route?.(event.model)
      if (event.type === 'fallback' && event.fallback) {
        const { failed, next, reason } = event.fallback
        context.events?.fallback?.(failed, next, new Error(reason))
      }
    })
    try {
      if (input.kind === 'image') return this.generateImage(execution, context.signal)
      if (input.kind === 'tools') return this.generateTools(execution, context)
      return this.generateRag(execution, context.messages, context.signal)
    } finally {
      unsubscribe()
    }
  }

  private async generateImage(
    execution: DesktopTurnExecution,
    signal: AbortSignal | undefined
  ): Promise<GenerationResult> {
    if (!this.boundary.generateImage) {
      throw new Error('Desktop image-generation boundary is unavailable')
    }
    const input = execution.input as DesktopImageChatSessionInput
    execution.imageActive = true
    try {
      const response = await this.boundary.generateImage(input.request)
      execution.imageResponse = response
      execution.generatedImages.push(response)
      return desktopImageResult(response, signal)
    } finally {
      execution.imageActive = false
    }
  }

  private async generateTools(
    execution: DesktopTurnExecution,
    context: DesktopGenerationContext
  ): Promise<GenerationResult> {
    if (!this.boundary.toolChat) throw new Error('Desktop tool-chat boundary is unavailable')
    const input = execution.input as DesktopToolChatSessionInput
    const response = await this.boundary.toolChat(input.query, desktopHistory(context.messages), {
      connectors: input.connectors,
      conversationId: input.conversationId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      allMemory: input.allMemory,
      images: input.images,
      imageAvailable: input.imageAvailable,
      streamId: input.turnId,
      thinking: input.thinking ?? false
    })
    execution.toolResponse = response
    await this.generateDeferredImages(execution, context)
    // Shared receives only terminal tool rows. The IPC stream owns the live running projection;
    // this transcript is the durable session outcome.
    this.publishToolCalls(input, response, context.events)
    if (context.signal?.aborted) {
      throw context.signal.reason ?? new Error('Desktop tool generation cancelled')
    }
    return desktopTextResult(response.answer ?? '', context.signal)
  }

  private publishToolCalls(
    input: DesktopToolChatSessionInput,
    response: DesktopToolChatResponse,
    events: GenerationEvents | undefined
  ): void {
    const calls = response.toolCalls ?? []
    if (!calls.length) return
    events?.message?.({
      role: 'assistant',
      content: '',
      toolCalls: calls.map((call, index) => ({
        id: `${input.turnId}:tool:${index}`,
        name: call.name,
        arguments: '{}'
      }))
    })
    calls.forEach((call, index) => {
      events?.message?.({
        role: 'tool',
        content: call.result,
        name: call.name,
        toolCallId: `${input.turnId}:tool:${index}`
      })
    })
  }

  private async generateDeferredImages(
    execution: DesktopTurnExecution,
    context: DesktopGenerationContext
  ): Promise<void> {
    const input = execution.input as DesktopToolChatSessionInput
    const response = execution.toolResponse
    if (!response) throw new Error(`Desktop tool response is missing for turn ${input.turnId}`)
    const requests = response.imageRequests?.length
      ? response.imageRequests
      : response.imageRequest?.prompt
        ? [response.imageRequest]
        : []
    if (!requests.length || !this.boundary.generateImage) return
    execution.imageActive = true
    try {
      for (const [index, request] of requests.entries()) {
        if (context.signal?.aborted) break
        await this.generateOptionalToolImage(execution, request, index, context)
      }
    } finally {
      execution.imageActive = false
    }
    context.events?.message?.({ role: 'assistant', content: response.answer ?? '' })
  }

  private async generateOptionalToolImage(
    execution: DesktopTurnExecution,
    request: NonNullable<DesktopToolChatResponse['imageRequest']>,
    requestIndex: number,
    context: DesktopGenerationContext
  ): Promise<void> {
    const input = execution.input as DesktopToolChatSessionInput
    const generateImage = this.boundary.generateImage
    if (!generateImage) return
    try {
      const image = await generateImage({
        prompt: request.prompt,
        conversationId: input.conversationId,
        projectId: input.projectId
      })
      execution.generatedImages.push(image)
      this.setDeferredImageToolOutcome(execution, requestIndex, {
        status: 'completed',
        result: 'Image created and added to the chat.'
      })
      if (request.proposal && this.boundary.storeProposalIllustration) {
        await this.boundary.storeProposalIllustration(
          request.proposal.conversationId,
          request.proposal.slide,
          image.path
        )
      }
      context.events?.message?.({
        role: 'assistant',
        content: [
          {
            type: 'image',
            id: image.syncId,
            uri: image.path,
            mimeType: 'image/png',
            seed: image.seed
          }
        ]
      })
    } catch (error) {
      const cancelled = Boolean(context.signal?.aborted) || /cancel/i.test(this.errorMessage(error))
      this.setDeferredImageToolOutcome(execution, requestIndex, {
        status: cancelled ? 'cancelled' : 'failed',
        result: cancelled
          ? 'Image generation was cancelled.'
          : `Image generation failed: ${this.errorMessage(error)}`
      })
    }
  }

  private setDeferredImageToolOutcome(
    execution: DesktopTurnExecution,
    requestIndex: number,
    outcome: { status: 'completed' | 'failed' | 'cancelled'; result: string }
  ): void {
    const calls = execution.toolResponse?.toolCalls
    if (!calls) return
    const call = calls.filter((candidate) => candidate.name === 'generate_image')[requestIndex]
    if (!call) return
    call.status = outcome.status
    call.result = outcome.result
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error && error.message.trim()
      ? error.message.trim()
      : 'The image runtime returned an unknown error.'
  }

  private async generateRag(
    execution: DesktopTurnExecution,
    messages: readonly GenerationMessage[],
    signal: AbortSignal | undefined
  ): Promise<GenerationResult> {
    const { input } = execution
    const response = await this.boundary.ragChat(
      input.query,
      'All',
      desktopHistory(messages),
      input.projectId,
      input.conversationId,
      input.noMemory && !input.projectId,
      input.turnId,
      input.thinking ?? false,
      input.images
    )
    execution.response = response
    const prompt = generatedImagePrompt(response.answer)
    if (!prompt || !this.boundary.generateImage || signal?.aborted) {
      return desktopTextResult(response.answer, signal, response.model)
    }
    execution.imageActive = true
    try {
      const image = await this.boundary.generateImage({
        prompt,
        conversationId: input.conversationId,
        projectId: input.projectId
      })
      execution.generatedImages.push(image)
      return desktopImageResult(image, signal)
    } finally {
      execution.imageActive = false
    }
  }
}
