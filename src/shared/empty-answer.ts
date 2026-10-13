// What to tell the user when a model finished without an answer, from why it stopped. Pure.

/**
 * The reason, in plain words. `finishReason` is the provider's stop reason; `maxTokens` the output
 * allowance the turn had.
 */
export function emptyAnswerReason(finishReason: string | null, maxTokens: number): string {
  if (finishReason === 'length') {
    return `The model used its whole output allowance (${maxTokens} tokens) before it answered, most likely on reasoning. Raise Context size or Max output in Settings > Text, or ask again.`
  }
  if (finishReason === 'content_filter') {
    return 'The model provider blocked this answer. Ask another way, or try another model.'
  }
  return 'The model finished without an answer. Ask again, or try another model.'
}

/** One last request when a turn ends empty: answer from what is already in the conversation. */
export const ANSWER_NOW_INSTRUCTION =
  'Answer the user now, in plain text, using the conversation and any tool results above. Keep any reasoning short. Do not call tools.'
