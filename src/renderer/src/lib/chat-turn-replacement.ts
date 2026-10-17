import type { Attachment, ChatMessage } from '../components/MemoryChat/types'
import type { ResponseVersion } from '../../../shared/chat-versions'
import { attachmentsOf } from '../components/MemoryChat/helper'
import { priorAnswerVersions } from './chat-versions'

export interface ReplacementSend {
  regen: true
  atts: Attachment[]
  conversationId: string
  history: ChatMessage[]
  /** The answers a retry sits beside, shown with the new one while it streams. Saved versions
   *  are rows; this list is never stored. */
  priorVariants?: ResponseVersion[]
  /** The saved answer the new one is a version of. */
  versionOf?: string
}

export interface ChatReplacementPlan {
  text: string
  user: ChatMessage
  /** Where the question sits in the shown chat. */
  userIndex: number
  atts: Attachment[]
  /** Editing adds a new version of the question; a retry adds a new version of its answer. */
  edited: boolean
  /** The shown answer a retry adds a version beside. */
  priorAnswer: ChatMessage | undefined
  /** What the model sees before the question. */
  history: ChatMessage[]
}

/**
 * Retry, resend and edit add a version beside the old message and delete nothing: the old answer
 * and the turns after it stay a version the person can go back to (chat-thread.ts in @offgrid/sync).
 */
export function planChatReplacement(
  messages: ChatMessage[],
  messageId: string,
  editedText?: string
): ChatReplacementPlan | undefined {
  let index = messages.findIndex((message) => message.id === messageId)
  if (index < 0) return undefined
  while (index >= 0 && messages[index]!.role !== 'user') index--
  if (index < 0) return undefined
  const user = messages[index]!
  const edited = editedText !== undefined
  const text = edited ? editedText.trim() : user.content
  if (!text) return undefined
  const priorAnswer = messages
    .slice(index + 1)
    .find((message) => message.role === 'assistant' && !message.notice)
  const atts = attachmentsOf(user).map((attachment) =>
    edited && attachment.kind === 'audio' ? { ...attachment, text } : attachment
  )
  const question = edited ? { ...user, content: text, threadVersions: undefined } : user
  return {
    text,
    user,
    userIndex: index,
    atts,
    edited,
    priorAnswer: edited ? undefined : priorAnswer,
    history: [...messages.slice(0, index), question]
  }
}

export interface ReplacementDependencies {
  conversationId: string | null
  messages: ChatMessage[]
  generating: ReadonlySet<string>
  cancelled: Set<string>
  newId: () => string
  listen: (cid: string, id: string) => () => void
  markGenerating: (cid: string, on: boolean) => void
  resetPreview: () => void
  stopTask: (cid: string) => Promise<void>
  addVersion: Window['api']['addRagMessageVersion']
  prepareAnswerVersion: Window['api']['prepareAnswerVersion']
  setMessages: (cid: string, update: (messages: ChatMessage[]) => ChatMessage[]) => void
  refresh: (cid: string) => Promise<unknown>
  announceSettled: (cid: string) => boolean
  drain: (cid: string) => void
  send: (text: string, options: ReplacementSend) => Promise<void>
}

export async function replaceChatTurn(
  dependencies: ReplacementDependencies,
  messageId: string,
  editedText?: string
): Promise<void> {
  const d = dependencies
  const cid = d.conversationId
  if (!cid || d.generating.has(cid)) return
  const plan = planChatReplacement(d.messages, messageId, editedText)
  if (!plan) return
  const preparationId = `prepare-${d.newId()}`
  const release = d.listen(cid, preparationId)
  d.cancelled.delete(cid)
  d.markGenerating(cid, true)
  d.resetPreview()
  let prepared = false
  try {
    await d.stopTask(cid)
    if (d.cancelled.has(preparationId)) return
    if (plan.edited) {
      const attachments = plan.atts.map(({ name, kind, text, path }) => ({ name, kind, text, path }))
      const context = attachments.length ? { attachments } : undefined
      const added = await d.addVersion(cid, plan.user.id, 'user', plan.text, context)
      if (!added) throw new Error('Saved user message was not found')
      const question: ChatMessage = {
        ...plan.user,
        id: added.uuid,
        content: plan.text,
        context,
        threadVersions: undefined
      }
      plan.history[plan.history.length - 1] = question
      d.setMessages(cid, (messages) => [...messages.slice(0, plan.userIndex), question])
    } else {
      if (plan.priorAnswer && !(await d.prepareAnswerVersion(cid, plan.priorAnswer.id)))
        throw new Error('Saved response was not found')
      d.setMessages(cid, (messages) => messages.slice(0, plan.userIndex + 1))
    }
    prepared = !d.cancelled.has(preparationId)
  } catch (error) {
    console.error('Failed to prepare the new version:', error)
  } finally {
    if (!prepared) {
      try {
        await d.refresh(cid)
      } catch (error) {
        console.error('Failed to restore the conversation:', error)
      } finally {
        release()
        d.cancelled.delete(preparationId)
        if (!d.announceSettled(cid)) d.drain(cid)
      }
    } else release()
  }
  if (!prepared) return
  try {
    await d.send(plan.text, {
      regen: true,
      atts: plan.atts,
      conversationId: cid,
      history: plan.history,
      ...(plan.priorAnswer
        ? { priorVariants: priorAnswerVersions(plan.priorAnswer), versionOf: plan.priorAnswer.id }
        : {})
    })
  } finally {
    // The new version now has siblings: read the thread back so its 1/2 switcher shows.
    await d.refresh(cid).catch(() => undefined)
  }
}
