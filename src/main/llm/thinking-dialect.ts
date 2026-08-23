// Which thinking controls the LOADED model actually understands.
//
// thinkingPayload used to send one pair to every model: chat_template_kwargs.enable_thinking plus
// reasoning_format 'deepseek'. That is the Qwen/Gemma dialect, and it is a no-op on a template that
// does not speak it. Muse Glimmer 30B has no enable_thinking variable and emits no <think> tags -
// it reads `reasoning_strength` and writes its reasoning on a separate assistant channel - so the
// toggle moved nothing and the reasoning was never separated out. The switch looked broken from the
// one side that could not see why.
//
// The template is the source of truth for what a model understands, and llama-server publishes it
// at /props. This module is the pure rule over that string; llm.ts does the fetching.

export type ThinkingDialect =
  /** enable_thinking + <think> delimiters. Qwen, Gemma and friends. */
  | 'enable-thinking'
  /** A reasoning_strength string rendered into the system prompt. Muse Glimmer / Onyx ATEM. */
  | 'reasoning-strength'
  /** The template exposes no thinking control we recognise. */
  | 'none'

/**
 * Read a chat template and report which thinking dialect it speaks.
 *
 * Detection is by the variable the template actually branches on, not by model name: a name is a
 * label someone chose, while the variable is what the renderer will read. A template we do not
 * recognise returns 'none', which is honest - we then send no thinking controls at all rather than
 * switches it will ignore.
 */
export function detectThinkingDialect(chatTemplate: string | undefined): ThinkingDialect {
  if (!chatTemplate) return 'none'
  if (chatTemplate.includes('enable_thinking')) return 'enable-thinking'
  if (chatTemplate.includes('reasoning_strength')) return 'reasoning-strength'
  return 'none'
}

export interface ThinkingFragment {
  chat_template_kwargs?: Record<string, unknown>
  reasoning_format?: string
}

/**
 * The request fragment that turns thinking on or off for THIS model.
 *
 * 'enable-thinking' keeps the long-standing behaviour byte-for-byte: the template switch plus
 * reasoning_format so llama.cpp splits the reasoning into reasoning_content instead of burying it
 * in the answer.
 *
 * 'reasoning-strength' sends only the switch its template reads. It deliberately does NOT send
 * reasoning_format 'deepseek': that parser looks for <think> delimiters this model never emits, so
 * asking for it can only fail to match. Leaving the field off lets the server apply its own
 * per-model handling for the channel the model does use.
 *
 * 'none' sends nothing. A control the template cannot read is not a safe default - it is a silent
 * lie to the user holding the toggle.
 */
export function thinkingFragmentFor(dialect: ThinkingDialect, thinking: boolean): ThinkingFragment {
  if (dialect === 'enable-thinking') {
    return thinking
      ? { chat_template_kwargs: { enable_thinking: true }, reasoning_format: 'deepseek' }
      : { chat_template_kwargs: { enable_thinking: false } }
  }
  if (dialect === 'reasoning-strength') {
    // The template's own fallback is 'high' when the variable is undefined or empty, so 'high' is
    // this model's natural on. The off value is NOT asserted here - see the note in llm.ts.
    return { chat_template_kwargs: { reasoning_strength: thinking ? 'high' : 'none' } }
  }
  return {}
}

/** Whether a toggle can do anything at all for this model - the UI should not offer a dead switch. */
export function supportsThinkingToggle(dialect: ThinkingDialect): boolean {
  return dialect !== 'none'
}
