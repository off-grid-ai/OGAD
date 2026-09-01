import type {
  GenerationMessage,
  GenerationOperation,
  GenerationRequest,
  GenerationResponseFormat,
  GenerationResult,
  GenerationToolChoice,
  GenerationToolDefinition
} from '@offgrid/models'
import { llm } from './llm'
import { readImages } from './llm/read-images'
import { desktopModelServices } from './model-services'

export interface DesktopGenerationOptions {
  operation?: GenerationOperation
  images?: string[]
  responseFormat?: unknown
  tools?: unknown[]
  toolChoice?: unknown
  temperature?: number
  topP?: number
  thinking?: boolean
  maxTokens?: number
  maxToolRounds?: number
  timeoutMs?: number
  signal?: AbortSignal
  allowFallback?: boolean
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

export async function generateDesktopMessages(
  messages: GenerationMessage[],
  options: DesktopGenerationOptions = {}
): Promise<GenerationResult> {
  await desktopModelServices.refresh()
  const turnId = `desktop:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const request: GenerationRequest = {
    operation: options.operation ?? { type: 'text' },
    messages,
    identity: { conversationId: turnId, turnId },
    responseFormat: responseFormat(options.responseFormat),
    tools: toolDefinitions(options.tools),
    toolChoice: toolChoice(options.toolChoice),
    sampling: {
      temperature: options.temperature,
      topP: options.topP
    },
    maxTokens: options.maxTokens,
    maxToolRounds: options.maxToolRounds,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    requiredCapabilities: {
      ...(options.thinking === undefined ? {} : { thinking: options.thinking })
    },
    allowFallback: options.allowFallback ?? true,
    partialOutputPolicy: 'discard-and-fallback'
  }
  return desktopModelServices.generation.generate(request)
}

export function generateDesktopText(
  prompt: string,
  options: DesktopGenerationOptions = {}
): Promise<GenerationResult> {
  return generateDesktopMessages(promptMessages(prompt, options.images), options)
}
