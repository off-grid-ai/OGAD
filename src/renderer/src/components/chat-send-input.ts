import type { Attachment } from '@renderer/lib/chat-transcript-types'
import type { ImageGenerationRequestContract } from '../../../shared/image-generation-contract'

export interface ChatSendOptions {
  /** An upstream workflow can own the identity of a new turn without making it a replay. */
  turnId?: string
  regen?: boolean
  voiceClip?: { url: string; duration: number }
  atts?: Attachment[]
  conversationId?: string
  imageRequest?: ImageGenerationRequestContract
  projectIdOverride?: string | null
  sessionReplay?: {
    type: 'regenerate' | 'edit'
    turnId: string
    anchor: { messageId: string; keepAnchor: boolean }
  }
  /** A form submission is user input even though its text is supplied as an argument. */
  asUserInput?: boolean
  /** Receives the authoritative answer at the point its owning path commits it. */
  onAnswer?: (answer: string) => void
}

export interface PreparedChatInput {
  isInput: boolean
  regen: boolean
  projectId: string | null
  atts: Attachment[]
  typed: string
  trimmed: string
  attachmentText: string
  imagePaths: string[]
  modelQuery: string
}

export function prepareChatInput(input: {
  override?: string
  options?: ChatSendOptions
  draft: string
  activeProjectId: string | null
  attachments: Attachment[]
}): PreparedChatInput {
  const isInput = input.override === undefined || input.options?.asUserInput === true
  const atts =
    input.options?.atts ??
    (isInput
      ? input.attachments.filter(
          (attachment) =>
            attachment.status === 'ready' && Boolean(attachment.text || attachment.path)
        )
      : [])
  const typed = (input.override ?? input.draft).trim()
  const attachmentText = atts
    .filter((attachment) => attachment.text)
    .map(
      (attachment) => `--- attached ${attachment.kind}: ${attachment.name} ---\n${attachment.text}`
    )
    .join('\n\n')
  return {
    isInput,
    regen: input.options?.regen ?? false,
    projectId:
      input.options?.projectIdOverride !== undefined
        ? input.options.projectIdOverride
        : input.activeProjectId,
    atts,
    typed,
    attachmentText,
    trimmed:
      typed || (atts.length ? `(${atts.length} attachment${atts.length > 1 ? 's' : ''})` : ''),
    imagePaths: atts.flatMap((attachment) =>
      attachment.kind === 'image' && attachment.path ? [attachment.path] : []
    ),
    modelQuery: (attachmentText ? `${attachmentText}\n\n${typed}` : typed).trim()
  }
}
