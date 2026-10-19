// Pure chat-message sanitization. No I/O. Extracted from model-server.ts.
//
// Some models (Gemma 4) enforce strict message ordering via their Jinja chat
// template: system messages MUST be at the very beginning. Clients like Claude
// Code intersperse system messages mid-conversation (tool context, updates),
// which makes the template raise "System message must be at the beginning".
// Fix: pull ALL system messages out, merge their content, and place a single
// system message at position 0. Non-system messages keep their original order.

/** Extract text from any system message content shape, preserving all readable parts. */
export function extractSystemText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as { type?: string; text?: string; content?: unknown }[])
    .map((p) => {
      if (p.type === 'text' && p.text) return p.text
      // tool_result / tool_use blocks may carry nested text - include them so
      // the merged system message retains all tool context, not just plain text.
      if (typeof p.content === 'string') return p.content
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Consolidate out-of-position system messages to a single leading system message.
 * Mutates `body.messages` in place (same as the original). Returns true when it
 * changed anything, false when there was nothing to fix.
 */
export function sanitizeChatMessages(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const b = body as { messages?: unknown[] }
  if (!Array.isArray(b.messages) || b.messages.length === 0) return false

  // Nothing to fix if there are no out-of-position system messages.
  // A single system message already at index 0 is valid.
  const firstIsSystem = (b.messages[0] as { role?: string }).role === 'system'
  const hasOutOfPosition = b.messages
    .slice(firstIsSystem ? 1 : 0)
    .some((m) => (m as { role?: string }).role === 'system')
  if (!hasOutOfPosition) return false

  // Collect all system message text, preserving original content of any first
  // system message at position 0 (keep its full content object, not just text).
  const extraParts: string[] = []
  const rest: unknown[] = []
  let leadSystem: unknown = null

  for (let i = 0; i < b.messages.length; i++) {
    const m = b.messages[i] as { role?: string; content?: unknown }
    if (m.role === 'system') {
      if (i === 0) {
        leadSystem = m // keep the lead system message as-is
      } else {
        const text = extractSystemText(m.content)
        if (text.trim()) extraParts.push(text.trim())
      }
    } else {
      rest.push(m)
    }
  }

  if (leadSystem) {
    // Append any out-of-position system content to the leading system message.
    if (extraParts.length) {
      const lead = leadSystem as { role: string; content: unknown }
      const base = extractSystemText(lead.content)
      lead.content = [base, ...extraParts].filter(Boolean).join('\n\n')
    }
    b.messages = [leadSystem, ...rest]
  } else {
    // No leading system message - create one from the merged parts.
    b.messages = [{ role: 'system', content: extraParts.join('\n\n') }, ...rest]
  }
  return true
}

export function parseDecisionChatMessages(messages: unknown): {
  context: string
  question: string
  options: string[]
} {
  if (!Array.isArray(messages)) throw new Error('Decision requests require messages.')
  const user = messages.filter((message) => message?.role === 'user').at(-1)
  const text = extractSystemText(user?.content)
  const match = /^Context:\n([\s\S]*)\nQuestion: ([\s\S]*)\nOptions:\n([\s\S]+)$/.exec(text)
  if (!match) throw new Error('Decision requests require Context, Question, and numbered Options.')
  const rows = [...match[3]!.matchAll(/^(\d+): ([\s\S]*?)(?=^\d+: |$(?![\s\S]))/gm)]
  if (rows.length < 2 || rows.some((row, index) => Number(row[1]) !== index || !row[2]!.trim()))
    throw new Error('Decision options must be numbered consecutively from zero.')
  if (!match[3]!.startsWith('0: ')) throw new Error('Decision options must start at zero.')
  return { context: match[1]!, question: match[2]!, options: rows.map((row) => row[2]!.trimEnd()) }
}

/** What a chat request's prompt weighs for team-mode admission: its characters without any inline
 *  image data (a base64 picture is not prompt text) and how many images it carries. */
export function chatPromptShape(body: unknown): { chars: number; images: number } {
  let images = 0
  const json = JSON.stringify(body, (_key, value: unknown) => {
    if (typeof value === 'string' && value.startsWith('data:image/')) {
      images += 1
      return ''
    }
    return value
  })
  return { chars: json.length, images }
}
