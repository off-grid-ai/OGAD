// Pure request-payload / message assembly, extracted from llm.ts so the payload
// shape (multimodal content parts, system message, thinking controls) is a single
// source of truth used by BOTH chat() and chatStream() and is unit-testable without
// a socket or fs. No http/fs/electron imports.
//
// The one impure step - reading image bytes off disk - stays in llm.ts; this module
// takes ALREADY-decoded image data (base64 + mime) so it is fully pure.

import { mimeForExt } from '../mime'
import { toWellFormedText } from './well-formed-text'
import {
  thinkingFragmentFor,
  type ThinkingDialect,
  type ThinkingFragment
} from './thinking-dialect'

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface DecodedImage {
  base64: string
  mime: string // e.g. 'image/png' | 'image/jpeg' | 'image/webp'
}

/** MIME type for an image path by extension, via the shared ext->MIME map (image/png
 *  fallback). Previously forced everything non-.png to image/jpeg, which mislabelled
 *  webp/gif/bmp/heic attachments in the RAG chat vision path (the vision model may
 *  reject a declared type that doesn't match the bytes). */
export function imageMime(imgPath: string): string {
  const ext = imgPath.split('.').pop() ?? ''
  return mimeForExt(ext, 'image/png')
}

/** Build the OpenAI-style multimodal content array: the text part first, then one
 *  image_url data-URI part per decoded image (in order). */
export function buildContentParts(message: string, images: DecodedImage[]): ContentPart[] {
  // Repair unpaired surrogates HERE, at the one place every request body is assembled: a lone
  // surrogate anywhere in the text makes the whole body unparseable to the model server.
  const content: ContentPart[] = [{ type: 'text', text: toWellFormedText(message) }]
  for (const img of images) {
    content.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } })
  }
  return content
}

/** Build the messages array: the user turn (multimodal content), with an optional
 *  system message unshifted in front when a non-blank system prompt is set.
 *  Mirrors both chat paths (they used `.trim()` to decide whether to prepend). */
export function buildMessages(
  message: string,
  images: DecodedImage[],
  systemPrompt: string
): { role: 'system' | 'user'; content: string | ContentPart[] }[] {
  const messages: { role: 'system' | 'user'; content: string | ContentPart[] }[] = [
    { role: 'user', content: buildContentParts(message, images) }
  ]
  if (systemPrompt.trim()) {
    messages.unshift({ role: 'system', content: toWellFormedText(systemPrompt) })
  }
  return messages
}

/** The chat_template_kwargs / reasoning_format fragment for the thinking control.
 *
 *  WHICH controls to send depends on the loaded model's template, so the rule lives in
 *  thinking-dialect.ts and this delegates. The dialect defaults to 'enable-thinking' - the
 *  long-standing Qwen/Gemma behaviour - so a caller that has not resolved a template behaves
 *  exactly as before. */
export function thinkingPayload(
  thinking: boolean,
  dialect: ThinkingDialect = 'enable-thinking'
): ThinkingFragment {
  return thinkingFragmentFor(dialect, thinking)
}

/** What a client asked for, or undefined when it said nothing about thinking. */
export function requestedThinking(body: Record<string, unknown>): boolean | undefined {
  const kwargs = body.chat_template_kwargs
  if (typeof kwargs !== 'object' || kwargs === null) return undefined
  const asked = (kwargs as Record<string, unknown>).enable_thinking
  return typeof asked === 'boolean' ? asked : undefined
}

/**
 * Answer a client's thinking request the way this server answers its own.
 *
 * Turning thinking on for the loaded model takes TWO things: the template switch, and
 * `reasoning_format` so llama.cpp separates the reasoning out instead of burying it. Only this
 * process knows the second one, because it is a property of the model server it runs, not of the
 * request. A client that sends the switch alone gets a model that reasons into nowhere: the phone
 * asked for thinking, the reply came back with an empty reasoning field, and the toggle looked
 * broken from the one side that could not see why.
 *
 * So a client says WHETHER it wants thinking, and this decides HOW. A request that says nothing is
 * left exactly as it is, and keeps the model's own default.
 *
 * Returns whether the body changed.
 */
export function applyThinkingPayload(body: Record<string, unknown>): boolean {
  const asked = requestedThinking(body)
  if (asked === undefined) return false
  const resolved = thinkingPayload(asked)
  body.chat_template_kwargs = resolved.chat_template_kwargs
  if (resolved.reasoning_format !== undefined) {
    body.reasoning_format = resolved.reasoning_format
  } else {
    delete body.reasoning_format
  }
  return true
}
