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
  ReasoningEffort
} from '@offgrid/models'
import { ModelCapabilityError, nativeToolPlannerUnavailableMessage } from '@offgrid/models'
import { llm } from './llm'
import { readImages } from './llm/read-images'
import { desktopModelServices } from './model-service-access'
import { desktopToolExecutor, type DesktopToolExecutionSession } from './desktop-tool-executor'

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
  timeoutMs?: number
  signal?: AbortSignal
  allowFallback?: boolean
  routeId?: string
  identity?: GenerationRequest['identity']
  events?: GenerationEvents
  toolExecution?: DesktopToolExecutionSession
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

export function promptMessages(prompt: string, images: string[] = []): GenerationMessage[] {
  const decoded = readImages(images)
  const messages: GenerationMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...decoded.map((image) => ({
          type: 'image' as const,
          mimeType: image.mime,
          data: image.base64
        }))
      ]
    }
  ]
  const systemPrompt = llm.getSettings().systemPrompt?.trim()
  if (systemPrompt) messages.unshift({ role: 'system', content: systemPrompt })
  return messages
}

function throwDesktopGenerationError(error: unknown): never {
  if (error instanceof ModelCapabilityError && error.unsupportedCapabilities.includes('tools')) {
    throw new Error(
      nativeToolPlannerUnavailableMessage({
        status: 'unsupported',
        modelName: error.model.name
      }),
      { cause: error }
    )
  }
  throw error
}

export async function generateDesktopMessages(
  messages: GenerationMessage[],
  options: DesktopGenerationOptions = {}
): Promise<GenerationResult> {
  await desktopModelServices.refresh()
  const settings = llm.getSettings()
  const activeTextModel = desktopModelServices.llm.active('text').model
  const needsVision = messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((part) => part.type === 'image')
  )
  const turnId = options.identity?.turnId ?? `desktop:${randomUUID()}`
  const request: GenerationRequest = {
    profile: options.profile,
    operation: options.operation ?? { type: 'text' },
    messages,
    identity: options.identity ?? { conversationId: turnId, turnId },
    responseFormat: responseFormat(options.responseFormat),
    tools: toolDefinitions(options.tools),
    toolChoice: toolChoice(options.toolChoice),
    toolHandling: options.toolHandling,
    sampling: {
      temperature: options.temperature,
      topP: options.topP
    },
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
            ...(settings.reasoningBudget && settings.reasoningBudget > 0
              ? { budgetTokens: settings.reasoningBudget }
              : {}),
            ...((options.reasoningEffort ?? settings.reasoningEffort)
              ? { effort: options.reasoningEffort ?? settings.reasoningEffort }
              : {})
          }
        }),
    requiredCapabilities: {
      ...(needsVision ? { vision: true } : {}),
      ...(options.thinking === undefined ? {} : { thinking: options.thinking })
    },
    // A selected remote route is an explicit provider boundary. Shared still owns capability and
    // route resolution, but it must report an unsupported selected route instead of silently
    // substituting another catalog model from that provider.
    allowFallback:
      options.allowFallback ??
      ((options.operation?.type ?? 'text') !== 'text' || activeTextModel?.source !== 'remote'),
    routeId: options.routeId,
    partialOutputPolicy: 'discard-and-fallback'
  }
  const unregister = options.toolExecution
    ? desktopToolExecutor.register(turnId, options.toolExecution)
    : undefined
  try {
    return await desktopModelServices.generation.generate(request, options.events)
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
  return generateDesktopMessages(promptMessages(prompt, options.images), options)
}

export async function generateDesktopOperation(
  operation: GenerationOperation,
  options: Pick<
    DesktopGenerationOptions,
    'profile' | 'identity' | 'events' | 'signal' | 'timeoutMs' | 'allowFallback'
  > & { routeId?: string } = {}
): Promise<GenerationResult> {
  await desktopModelServices.refresh()
  const modality = operation.type === 'classifier' ? 'classifier' : operation.type
  const modelId = 'modelId' in operation ? operation.modelId : undefined
  const routeId = options.routeId ?? desktopModelServices.routeIdFor(modality, modelId)
  const turnId = options.identity?.turnId ?? `desktop:${randomUUID()}`
  return desktopModelServices.generation.generate(
    {
      profile: options.profile,
      operation,
      identity: options.identity ?? { conversationId: turnId, turnId },
      routeId,
      allowFallback: options.allowFallback ?? false,
      signal: options.signal,
      timeoutMs: options.timeoutMs
    },
    options.events
  )
}

/** Read the canonical selected model from LLMService without exposing its store to adapters. */
export function activeDesktopModelId(
  modality: Parameters<typeof desktopModelServices.llm.active>[0]
): string | null {
  return desktopModelServices.llm.active(modality).model?.id ?? null
}
