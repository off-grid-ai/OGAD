import { AGENT_ROLE_INSTRUCTIONS, splitAtImage } from '@offgrid/use'
import type { WebUseAgentEndpoint } from '../../shared/web-use-settings'

/** Output budgets from docs/MODEL_CONTRACT.md (size targets), with room to spare. */
const MAX_TOKENS = { planner: 600, actor: 48, evaluator: 96, answerer: 300 } as const
/** A general model writes a little more around the same reply. */
const GENERAL_MAX_TOKENS = { planner: 800, actor: 96, evaluator: 200, answerer: 400 } as const
const REQUEST_TIMEOUT_MS = 60_000

export type BrowserAgentRole = keyof typeof MAX_TOKENS

type ContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

/**
 * One request to one model of the planner_actor_evaluator strategy, as the training data has it
 * (scripts/action-data/train/build_dataset.py): a single user message, no system prompt,
 * greedy decoding. With an image, the request text is split at its `<image>` line and the
 * image goes between the two parts.
 *
 * The llama.cpp server for each model must run with `--jinja --reasoning-format none`: otherwise
 * it moves the trained `<think>` prefix and the whole answer into reasoning_content and returns
 * empty content. The loop removes the think tags (agentReplyText). Vision models (actor,
 * evaluator) need llama.cpp b11669 or newer for the MiniCPM-V 4.7 projector, and
 * `--image-max-tokens 320` as in training; both can load the same mmproj file.
 */
export async function callBrowserAgentModel(
  role: BrowserAgentRole,
  endpoint: WebUseAgentEndpoint,
  request: string,
  image: Buffer | null,
  signal?: AbortSignal
): Promise<string> {
  let content: string | ContentPart[] = request
  if (image) {
    const { before, after } = splitAtImage(request)
    content = [
      { type: 'text', text: before },
      {
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}` }
      },
      { type: 'text', text: after }
    ]
  }
  const messages = endpoint.instructions
    ? [
        { role: 'system', content: AGENT_ROLE_INSTRUCTIONS[role] },
        { role: 'user', content }
      ]
    : [{ role: 'user', content }]
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  // A remote endpoint (a tunnel, a LAN server) can drop one request: try it again, at most twice.
  const send = async (attempt: number): Promise<Response> => {
    try {
      return await fetch(`${endpoint.baseUrl}/chat/completions`, init)
    } catch (error) {
      if (attempt >= 2 || signal?.aborted || timeout.aborted) throw error
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
      return send(attempt + 1)
    }
  }
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: endpoint.model,
      messages,
      temperature: 0,
      max_tokens: (endpoint.instructions ? GENERAL_MAX_TOKENS : MAX_TOKENS)[role],
      stream: false,
      // The models were trained on the non-thinking prompt (an empty think block); ask the server
      // for the same, so a reply is a verdict or an action, not reasoning.
      chat_template_kwargs: { enable_thinking: false },
      // llama.cpp: reuse the processed prefix (GOAL and PLAN come first in every request).
      cache_prompt: true
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  }
  const response = await send(0)
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)
    throw new Error(
      `The ${role} model at ${endpoint.baseUrl} answered ${response.status}: ${detail}`
    )
  }
  const body = (await response.json()) as {
    choices?: { message?: { content?: unknown } }[]
  }
  const text = body.choices?.[0]?.message?.content
  if (typeof text !== 'string') throw new Error(`The ${role} model returned no text.`)
  return text
}
