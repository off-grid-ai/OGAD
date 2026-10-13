import type { Attachment, ChatMessage } from '../components/MemoryChat/types'
import type { ResponseVersion } from '../../../shared/chat-versions'
import { attachmentsOf, taskReferencesInMessages } from '../components/MemoryChat/helper'
import { editedBranch } from './chat-edit-branch'
import { priorAnswerVersions } from './chat-versions'

export interface ReplacementSend {
  regen: true
  atts: Attachment[]
  priorVariants?: ResponseVersion[]
  priorAnswer?: ChatMessage
  replacementMessageId?: string
  conversationId: string
  history: ChatMessage[]
}

export interface ChatReplacementPlan {
  text: string
  user: ChatMessage
  atts: Attachment[]
  branch: ReturnType<typeof editedBranch> | undefined
  retainedCount: number
  history: ChatMessage[]
  priorAnswer: ChatMessage | undefined
  priorVariants: ResponseVersion[] | undefined
  replacedTaskIds: string[]
}

/** Edits form a new branch; regeneration retains the same question's answers. */
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
  const text = editedText === undefined ? user.content : editedText.trim()
  if (!text) return undefined
  const priorAnswer = messages
    .slice(index + 1)
    .find((message) => message.role === 'assistant' && !message.notice)
  const branch = editedText === undefined ? undefined : editedBranch(messages, index, text)
  const atts = attachmentsOf(user).map((attachment) =>
    branch && attachment.kind === 'audio' ? { ...attachment, text } : attachment
  )
  return {
    text,
    user,
    atts,
    branch,
    retainedCount:
      branch?.retainedCount ?? (priorAnswer ? messages.indexOf(priorAnswer) + 1 : index + 1),
    history: branch?.history ?? messages.slice(0, index + 1),
    priorAnswer: branch ? undefined : priorAnswer,
    priorVariants: branch ? undefined : priorAnswerVersions(priorAnswer),
    replacedTaskIds: taskReferencesInMessages(messages.slice(index + 1))
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
  update: Window['api']['updateRagMessage']
  truncate: Window['api']['truncateRagMessages']
  removeTasks: (ids: string[]) => Promise<unknown>
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
    if (plan.branch) {
      const attachments = plan.atts.map(({ name, kind, text, path }) => ({
        name,
        kind,
        text,
        path
      }))
      const context = { ...plan.branch.context, ...(attachments.length ? { attachments } : {}) }
      if (!(await d.update(cid, plan.user.id, plan.text, context)))
        throw new Error('Saved user message was not found')
      d.setMessages(cid, (messages) =>
        messages.map((message) =>
          message.id === plan.user.id ? { ...message, content: plan.text, context } : message
        )
      )
      if (d.cancelled.has(preparationId)) return
    }
    await d.truncate(cid, plan.retainedCount)
    d.setMessages(cid, (messages) => messages.slice(0, plan.retainedCount))
    if (d.cancelled.has(preparationId)) return
    if (plan.replacedTaskIds.length) await d.removeTasks(plan.replacedTaskIds)
    prepared = !d.cancelled.has(preparationId)
  } catch (error) {
    console.error('Failed to prepare the replacement response:', error)
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
      priorVariants: plan.priorVariants,
      priorAnswer: plan.priorAnswer,
      replacementMessageId: plan.priorAnswer?.id,
      conversationId: cid,
      history: plan.history
    })
  } finally {
    if (plan.replacedTaskIds.length) await d.removeTasks(plan.replacedTaskIds)
  }
}
