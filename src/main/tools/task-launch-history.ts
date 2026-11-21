/**
 * An earlier turn that started a task is saved with the tool's launch note as its reply ("Task
 * reference: <id>. Web Use started. … Do not call web_use again"). Sent back to the model as
 * history, that note reads like an answer it may write itself. Found live: asked for another web
 * task, the model copied the note with a new id and called no tool, so the chat said "Web Use
 * started" while nothing ran. The model sees instead that a tool was called.
 */
const LAUNCH_NOTE = /^\s*Task reference:\s*[\w-]+\.\s*(Web|Computer) Use started\b/i

export function historyContentForModel(role: string, content: string): string {
  if (role !== 'assistant') return content
  const launched = content.match(LAUNCH_NOTE)
  if (!launched) return content
  const tool = launched[1]?.toLowerCase() === 'computer' ? 'computer_use' : 'web_use'
  return `I called ${tool} for that request.`
}

/** A reply that says a task started. True with no task tool called means the model made it up. */
const LAUNCH_CLAIM =
  /Task reference:\s*[\w-]+|\b(?:Web|Computer) Use started\b|\bI called (?:web|computer)_use\b/i

export function claimsTaskLaunch(answer: string): boolean {
  return LAUNCH_CLAIM.test(answer)
}

/** Said to the model once when it claimed a launch without calling the tool. */
export const LAUNCH_CLAIM_RETRY_INSTRUCTION =
  'You replied that a task started, but you called no tool, so nothing is running. If the request needs a website or an app, call web_use or computer_use now with the full goal. Otherwise answer the request directly. Never write a task reference yourself.'
