// Pure request-payload / message assembly, extracted from llm.ts so the payload
// shape (multimodal content parts, system message, thinking controls) is a single
// source of truth used by BOTH chat() and chatStream() and is unit-testable without
// a socket or fs. No http/fs/electron imports.
//
// The one impure step - reading image bytes off disk - stays in llm.ts; this module
// takes ALREADY-decoded image data (base64 + mime) so it is fully pure.

import { mimeForExt } from '../mime'
import {
  applyRequestedLlamaServerThinking,
  llamaServerThinkingPayload,
  openAICompatibleContentParts,
  openAICompatibleMessages,
  requestedLlamaServerThinking,
  type DecodedImagePayload,
  type ModelReasoningMetadata,
  type OpenAICompatibleContentPart,
  type OpenAICompatibleMessage
} from '@offgrid/models'

export type ContentPart = OpenAICompatibleContentPart
export type DecodedImage = DecodedImagePayload
export type ChatMessage = OpenAICompatibleMessage

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
  return openAICompatibleContentParts(message, images)
}

/** Build the messages array: the user turn (multimodal content), with an optional
 *  system message unshifted in front when a non-blank system prompt is set.
 *  Mirrors both chat paths (they used `.trim()` to decide whether to prepend). */
export function buildMessages(
  message: string,
  images: DecodedImage[],
  systemPrompt: string
): ChatMessage[] {
  return openAICompatibleMessages(message, images, systemPrompt)
}

/** The chat_template_kwargs / reasoning_format fragment for the thinking control.
 *
 *  WHICH controls to send depends on the loaded model's template, so the rule lives in
 *  thinking-dialect.ts and this delegates. The dialect defaults to 'enable-thinking' - the
 *  long-standing Qwen/Gemma behaviour - so a caller that has not resolved a template behaves
 *  exactly as before. */
export function thinkingPayload(
  thinking: boolean,
  dialect: ModelReasoningMetadata['control'] = 'enable-thinking'
) {
  return llamaServerThinkingPayload(thinking, dialect)
}

/** What a client asked for, or undefined when it said nothing about thinking. */
export function requestedThinking(body: Record<string, unknown>): boolean | undefined {
  return requestedLlamaServerThinking(body)
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
  return applyRequestedLlamaServerThinking(body)
}
