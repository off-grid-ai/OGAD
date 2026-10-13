// Decision + Reasoning proposes 1 to 3 candidate actions for the Decision model to choose
// from. Each is validated on its own: one malformed proposal (a click with no ref) is dropped
// rather than failing the whole web task, while an invalid action is still never offered or
// run. Only when no proposal is valid does the step fail, with the first validator error.

export function keepValidCandidates<T>(raw: readonly unknown[], parse: (value: unknown) => T): T[] {
  const valid: T[] = []
  let firstError: unknown = null
  for (const candidate of raw) {
    try {
      valid.push(parse(candidate))
    } catch (error) {
      firstError ??= error
    }
  }
  if (valid.length === 0) throw firstError ?? new Error('No candidate action was proposed.')
  if (valid.length < raw.length) {
    console.warn('[web-use][semantic] dropped invalid candidates', {
      proposed: raw.length,
      kept: valid.length
    })
  }
  return valid
}

/**
 * The model's reply was not an action that can run (a navigate with no URL, a reply cut off).
 * Found against a real signup page: one such reply ended the whole task. It is a reason to ask
 * again with what was wrong, not to end the task.
 */
export class InvalidDecisionError extends Error {
  constructor(readonly detail: string) {
    super(`The text model returned an invalid Web Use action: ${detail}.`)
    this.name = 'InvalidDecisionError'
  }
}

/** The Decision model chose "none of these": a reason to ask again, not to end the task. */
export class NoSupportedActionError extends Error {
  constructor() {
    super('The Web Use Decision model did not select a supported action.')
    this.name = 'NoSupportedActionError'
  }
}
