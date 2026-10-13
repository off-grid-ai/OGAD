/** A Web Use or Computer Use task carries two texts. The goal is written for the model: it frames
 *  the user's request, the prerequisites already done and the structured summary under section
 *  labels. The title is what a person reads in the Live Task header, the Task Record, Task History
 *  and the phone's task cards: one plain sentence with no labels and no long links. */

export const TASK_GOAL_REQUEST_LABEL = 'Current user request (authoritative):'
export const TASK_GOAL_PREREQUISITES_LABEL =
  'Completed prerequisites (already done; continue from this state):'
export const TASK_GOAL_SUMMARY_LABEL = 'Structured task summary:'

const SECTION_LABELS = [
  TASK_GOAL_REQUEST_LABEL,
  TASK_GOAL_PREREQUISITES_LABEL,
  TASK_GOAL_SUMMARY_LABEL
]
const MAX_TITLE_LENGTH = 80
const URL_PATTERN = /\bhttps?:\/\/[^\s)>\]]+/gi
const TOOL_PREAMBLE =
  /^(?:please\s+)?(?:use|using)\s+(?:the\s+)?(?:web|computer)\s+use\s+(?:to\s+)?/i

function section(text: string, label: string): string | undefined {
  const start = text.indexOf(label)
  if (start < 0) return undefined
  const body = text.slice(start + label.length)
  const ends = SECTION_LABELS.map((other) => body.indexOf(`\n\n${other}`)).filter((at) => at >= 0)
  return (ends.length ? body.slice(0, Math.min(...ends)) : body).trim()
}

function shortLink(url: string): string {
  try {
    const parsed = new URL(url.replace(/[.,;:!?]+$/, ''))
    const host = parsed.hostname.replace(/^www\./, '')
    const path = parsed.pathname.replace(/\/+$/, '')
    const firstSegment = path.split('/').filter(Boolean)[0]
    return firstSegment && path.split('/').filter(Boolean).length === 1
      ? `${host}/${firstSegment}`
      : host
  } catch {
    return url
  }
}

function firstSentence(text: string): string {
  const match = /^(.+?[.!?])(?:\s|$)/.exec(text)
  return (match?.[1] ?? text).replace(/[.!?]+$/, '').trim()
}

function bounded(text: string): string {
  if (text.length <= MAX_TITLE_LENGTH) return text
  const cut = text.slice(0, MAX_TITLE_LENGTH - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > MAX_TITLE_LENGTH / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`
}

/** The request a person wrote, in full, without the labels written for the model. For a view that
 *  shows the whole goal on request (a "See more"), where a shortened title would hide it. */
export function taskRequestText(goal: string | undefined): string {
  const text = goal?.trim() ?? ''
  return section(text, TASK_GOAL_REQUEST_LABEL) ?? section(text, TASK_GOAL_SUMMARY_LABEL) ?? text
}

/** The short, plain task name shown to a person. Idempotent: a title passes through unchanged. */
export function taskDisplayTitle(goal: string | undefined): string {
  const text = goal?.trim() ?? ''
  if (!text) return ''
  const plain = taskRequestText(text)
    .replace(URL_PATTERN, (url) => shortLink(url))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TOOL_PREAMBLE, '')
  const sentence = firstSentence(plain)
  if (!sentence) return ''
  return bounded(sentence.charAt(0).toUpperCase() + sentence.slice(1))
}
