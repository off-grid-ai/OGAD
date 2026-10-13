// Suggested next message for Desktop and browser chat; Tab accepts it as a draft.
// Pure: the prompt that asks for it, and the cleanup that decides whether a reply is usable.

type AgentMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/** A suggestion longer than this is not one instruction. */
export const MAX_SUGGESTION_CHARS = 90

const SYSTEM =
  'You suggest the next thing the user might ask a browser assistant to do on the page they are on. ' +
  'Reply with one short instruction in the imperative, under 12 words, with no quotes, no ' +
  'preamble and no punctuation at the end. If nothing useful follows, reply with NONE.'

/** The request: what was asked, how it ended, and where the user is now. Text only, no tools. */
export function suggestionMessages(s: {
  readonly asked: string
  readonly answer: string
  readonly pageTitle?: string
  readonly surface?: 'browser' | 'desktop'
}): AgentMessage[] {
  const page = s.pageTitle ? `\nThe user is on: ${s.pageTitle.slice(0, 120)}` : ''
  return [
    {
      role: 'system',
      content:
        s.surface === 'desktop'
          ? SYSTEM.replace(
              'a browser assistant to do on the page they are on',
              'their assistant to do next in this conversation'
            )
          : SYSTEM
    },
    {
      role: 'user',
      content: `The user asked: ${s.asked.slice(0, 400)}\nThe assistant answered: ${s.answer.slice(0, 600)}${page}\nWhat should they ask next?`
    }
  ]
}

/** The model's reply as one usable instruction, or null when it is not one. */
export function cleanSuggestion(raw: string): string | null {
  const line =
    raw
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  const text = line
    .replace(/^(next( step)?|suggestion|try)\s*[:-]\s*/i, '')
    .replace(/^["'`*\-\s]+|["'`*\s]+$/g, '')
    .replace(/[.!]+$/, '')
    .trim()
  if (text.length < 3 || text.length > MAX_SUGGESTION_CHARS || /^none\b/i.test(text)) {
    return null
  }
  return text
}
