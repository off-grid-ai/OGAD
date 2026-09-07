import { randomUUID } from 'node:crypto'
import type {
  GenerationMessage,
  GenerationEvents,
  GenerationOperation,
  GenerationRequest,
  GenerationResponseFormat,
  GenerationResult,
  GenerationToolChoice,
  GenerationToolDefinition,
  GenerationToolHandling,
  GenerationProfileKind,
  ModelModality,
  ReasoningEffort
} from '@offgrid/models'
import {
  isReasoningEffort,
  nativeToolPlannerUnavailableMessage,
  prepareSingleShotChatRequest
} from '@offgrid/models'
import { readImages } from './llm/read-images'
import { desktopToolExecutor, type DesktopToolExecutionSession } from './desktop-tool-executor'
import {
  desktopModels,
  DesktopModelsOperationError,
  generateWithDesktopModels,
  refreshDesktopModels
} from './composition/application-access'

export interface DesktopGenerationOptions {
  /** The kind of work; shared resolves sampling, reasoning, timeout, and caps from it. */
  profile?: GenerationProfileKind
  operation?: GenerationOperation
  images?: string[]
  responseFormat?: unknown
  tools?: unknown[]
  toolChoice?: unknown
  toolHandling?: GenerationToolHandling
  temperature?: number
  topP?: number
  thinking?: boolean
  reasoningEffort?: ReasoningEffort
  maxTokens?: number
  maxToolRounds?: number
  maxToolCalls?: number
  /** A caller-owned bound (a test fence). Production sites name a profile instead. */
  timeoutMs?: number
  signal?: AbortSignal
  routeId?: string
  identity?: GenerationRequest['identity']
  events?: GenerationEvents
  toolExecution?: DesktopToolExecutionSession
  /**
   * A system prompt already prepared by the canonical `@offgrid/models` chat-context owner.
   * Desktop does not compose one; when omitted the stored user setting is used as-is.
   */
  systemPrompt?: string
}

function responseFormat(value: unknown): GenerationResponseFormat | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.type === 'json_object') return { type: 'json_object' }
  if (record.type !== 'json_schema') return undefined
  const jsonSchema = record.json_schema
  if (!jsonSchema || typeof jsonSchema !== 'object') return undefined
  const schema = jsonSchema as Record<string, unknown>
  if (typeof schema.name !== 'string' || !schema.schema || typeof schema.schema !== 'object') {
    return undefined
  }
  return {
    type: 'json_schema',
    name: schema.name,
    schema: schema.schema as Record<string, unknown>,
    ...(typeof schema.strict === 'boolean' ? { strict: schema.strict } : {})
  }
}

function toolDefinitions(value: unknown[] | undefined): GenerationToolDefinition[] | undefined {
  if (!value?.length) return undefined
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const fn = record.function
    if (!fn || typeof fn !== 'object') return []
    const definition = fn as Record<string, unknown>
    if (typeof definition.name !== 'string') return []
    return [
      {
        name: definition.name,
        ...(typeof definition.description === 'string'
          ? { description: definition.description }
          : {}),
        ...(typeof definition.strict === 'boolean' ? { strict: definition.strict } : {}),
        inputSchema:
          definition.parameters && typeof definition.parameters === 'object'
            ? (definition.parameters as Record<string, unknown>)
            : {}
      }
    ]
  })
}

function toolChoice(value: unknown): GenerationToolChoice | undefined {
  if (value === 'auto' || value === 'none' || value === 'required') return value
  if (!value || typeof value !== 'object') return undefined
  const fn = (value as Record<string, unknown>).function
  return fn && typeof fn === 'object' && typeof (fn as Record<string, unknown>).name === 'string'
    ? { name: (fn as Record<string, unknown>).name as string }
    : undefined
}

/**
 * Wraps an ALREADY-PREPARED prompt (and an already-prepared system prompt) as a generation
 * request. It applies no prompt rules of its own; `@offgrid/models` owns prompt composition.
 */
export function promptMessages(
  prompt: string,
  images: string[] = [],
  preparedSystemPrompt: string = committedSystemPrompt()
): GenerationMessage[] {
  const decoded = readImages(images)
  const systemPrompt = preparedSystemPrompt.trim()
  const { messages } = prepareSingleShotChatRequest({
    systemPrompt,
    message: prompt,
    images: decoded.map((image) => ({ data: image.base64, mimeType: image.mime }))
  })
  return systemPrompt ? messages : messages.slice(1)
}

function committedSystemPrompt(): string {
  const value = desktopModels.snapshot().settings.systemPrompt
  return typeof value === 'string' ? value : ''
}

function throwDesktopGenerationError(error: unknown): never {
  if (
    error instanceof DesktopModelsOperationError &&
    error.failure.kind === 'unsupported_capability' &&
    error.failure.capabilities.includes('tools')
  ) {
    throw new Error(
      nativeToolPlannerUnavailableMessage({
        status: 'unsupported',
        modelName: error.failure.modelName
      }),
      { cause: error }
    )
  }
  throw error
}

function generationReasoningPreferences(settings: {
  reasoningBudget?: unknown
  reasoningEffort?: unknown
}): { budget?: number; effort?: ReasoningEffort } {
  const budget =
    typeof settings.reasoningBudget === 'number' &&
    Number.isFinite(settings.reasoningBudget) &&
    settings.reasoningBudget > 0
      ? settings.reasoningBudget
      : undefined
  return {
    budget,
    effort: isReasoningEffort(settings.reasoningEffort) ? settings.reasoningEffort : undefined
  }
}

function createDesktopGenerationRequest(
  messages: GenerationMessage[],
  options: DesktopGenerationOptions,
  preferences: { budget?: number; effort?: ReasoningEffort }
): { request: GenerationRequest; turnId: string } {
  const needsVision = messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((part) => part.type === 'image')
  )
  const turnId = options.identity?.turnId ?? `desktop:${randomUUID()}`
  return {
    turnId,
    request: {
      profile: options.profile,
      operation: options.operation ?? { type: 'text' },
      messages,
      identity: options.identity ?? { conversationId: turnId, turnId },
      responseFormat: responseFormat(options.responseFormat),
      tools: toolDefinitions(options.tools),
      toolChoice: toolChoice(options.toolChoice),
      toolHandling: options.toolHandling,
      sampling: { temperature: options.temperature, topP: options.topP },
      maxTokens: options.maxTokens,
      maxToolRounds: options.maxToolRounds,
      maxToolCalls: options.maxToolCalls,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      ...(options.thinking === undefined
        ? {}
        : {
            reasoning: {
              enabled: options.thinking,
              ...(preferences.budget ? { budgetTokens: preferences.budget } : {}),
              ...((options.reasoningEffort ?? preferences.effort)
                ? { effort: options.reasoningEffort ?? preferences.effort }
                : {})
            }
          }),
      requiredCapabilities: {
        ...(needsVision ? { vision: true } : {}),
        ...(options.thinking === undefined ? {} : { thinking: options.thinking })
      },
      routeId: options.routeId
    }
  }
}

export async function generateDesktopMessages(
  messages: GenerationMessage[],
  options: DesktopGenerationOptions = {}
): Promise<GenerationResult> {
  await refreshDesktopModels()
  const { request, turnId } = createDesktopGenerationRequest(
    messages,
    options,
    generationReasoningPreferences(desktopModels.snapshot().settings)
  )
  const unregister = options.toolExecution
    ? desktopToolExecutor.register(turnId, options.toolExecution)
    : undefined
  try {
    return await generateWithDesktopModels(request, options.events)
  } catch (error) {
    return throwDesktopGenerationError(error)
  } finally {
    unregister?.()
  }
}

export function generateDesktopText(
  prompt: string,
  options: DesktopGenerationOptions = {}
): Promise<GenerationResult> {
  return generateDesktopMessages(
    promptMessages(prompt, options.images, options.systemPrompt),
    options
  )
}

export async function generateDesktopOperation(
  operation: GenerationOperation,
  options: Pick<DesktopGenerationOptions, 'profile' | 'identity' | 'events' | 'signal'> & {
    routeId?: string
  } = {}
): Promise<GenerationResult> {
  await refreshDesktopModels()
  const modality = operation.type === 'classifier' ? 'classifier' : operation.type
  const modelId = 'modelId' in operation ? operation.modelId : undefined
  const routeId =
    options.routeId ??
    (modelId ? (desktopModels.resolveRoute(modality, modelId) ?? undefined) : undefined)
  const turnId = options.identity?.turnId ?? `desktop:${randomUUID()}`
  return generateWithDesktopModels(
    {
      profile: options.profile,
      operation,
      identity: options.identity ?? { conversationId: turnId, turnId },
      routeId,
      signal: options.signal
    },
    options.events
  )
}

/** Read the canonical selected model from LLMService without exposing its store to adapters. */
export function activeDesktopModelId(modality: ModelModality): string | null {
  return desktopModels.snapshot().active[modality]?.model?.id ?? null
}
