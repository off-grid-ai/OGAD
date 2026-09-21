import type { OptionDecision } from '../llm'
import type {
  RemoteVisionCatalogModel,
  RemoteVisionProvider
} from '../../shared/remote-vision-server'

export interface RemoteDecisionConnection {
  provider: Exclude<RemoteVisionProvider, 'local'>
  endpoint: string
  model: string
  apiKey: string
  modelCatalog?: RemoteVisionCatalogModel[]
}

interface OpenRouterChoiceAnswer {
  type?: unknown
  choice?: unknown
  probabilities?: unknown
}

/** Use provider capability metadata instead of model names to select a transport. */
export function usesOpenRouterDecisions(remote: RemoteDecisionConnection): boolean {
  if (remote.provider !== 'openrouter') return false
  return Boolean(
    remote.modelCatalog
      ?.find((model) => model.id === remote.model)
      ?.outputModalities?.includes('decisions')
  )
}

/** OpenRouter serves Decisions beside, not below, its OpenAI-compatible v1 API. */
export function openRouterDecisionsEndpoint(endpoint: string): string {
  const normalized = endpoint.trim().replace(/\/+$/, '')
  if (!/\/v1$/i.test(normalized)) {
    throw new Error(
      'The OpenRouter Decisions endpoint cannot be derived from this server address. Use an address that ends in /v1.'
    )
  }
  return `${normalized.replace(/\/v1$/i, '/alpha')}/decisions`
}

export function buildOpenRouterDecisionRequest(
  model: string,
  context: string,
  question: string,
  options: readonly string[]
): Record<string, unknown> {
  return {
    model,
    state: { context },
    questions: {
      decision: {
        type: 'choice',
        instructions: question,
        criteria: Object.fromEntries(options.map((option, index) => [`option_${index}`, option]))
      }
    }
  }
}

export function parseOpenRouterDecisionResponse(
  body: unknown,
  optionCount: number
): OptionDecision {
  const answer = (body as { answers?: { decision?: OpenRouterChoiceAnswer } })?.answers?.decision
  const choiceKey = typeof answer?.choice === 'string' ? answer.choice : ''
  const match = /^option_(\d+)$/.exec(choiceKey)
  const choice = match ? Number(match[1]) : -1
  if (answer?.type !== 'choice' || choice < 0 || choice >= optionCount) {
    throw new Error('The remote Decision model returned an invalid choice.')
  }

  const supplied =
    answer.probabilities && typeof answer.probabilities === 'object'
      ? Array.from({ length: optionCount }, (_, index) => {
          const value = (answer.probabilities as Record<string, unknown>)[`option_${index}`]
          return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
        })
      : []
  const total = supplied.reduce((sum, probability) => sum + probability, 0)
  const probabilities =
    supplied.length === optionCount && total > 0
      ? supplied.map((probability) => probability / total)
      : Array.from({ length: optionCount }, (_, index) => (index === choice ? 1 : 0))
  return { choice, confidence: probabilities[choice] ?? 1, probabilities }
}

function providerError(status: number, rawBody: string): Error {
  let detail = rawBody.trim().slice(0, 500)
  try {
    const body = JSON.parse(rawBody) as { error?: { message?: unknown }; message?: unknown }
    const message = body.error?.message ?? body.message
    if (typeof message === 'string' && message.trim()) detail = message.trim()
  } catch {
    // The bounded plain-text response is still useful.
  }
  return new Error(`Remote Decision model returned HTTP ${status}${detail ? `: ${detail}` : '.'}`)
}

export async function decideWithOpenRouter(
  remote: RemoteDecisionConnection,
  context: string,
  question: string,
  options: readonly string[],
  signal?: AbortSignal
): Promise<OptionDecision> {
  let response: Response
  try {
    response = await fetch(openRouterDecisionsEndpoint(remote.endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(remote.apiKey ? { Authorization: `Bearer ${remote.apiKey}` } : {})
      },
      body: JSON.stringify(
        buildOpenRouterDecisionRequest(remote.model, context, question, options)
      ),
      signal
    })
  } catch (error) {
    if (signal?.aborted) throw error
    const message = error instanceof Error ? error.message : 'network error'
    throw new Error(`Remote Decision model connection failed: ${message}`)
  }
  const rawBody = await response.text()
  if (!response.ok) throw providerError(response.status, rawBody)
  try {
    return parseOpenRouterDecisionResponse(JSON.parse(rawBody), options.length)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('The remote Decision model')) throw error
    throw new Error('The remote Decision model returned an invalid response.')
  }
}
