import type { TaskGuideAttachmentInput } from '../../../shared/task-guidance'
import { executeWorkspaceContentCommand } from './workspace-content-client'

interface TaskGuideResult {
  available: boolean
  accepted?: boolean
  reason?: string
}

export interface SubmitTaskGuidanceInput {
  taskId: string
  journeyId?: string
  text: string
  attachments?: TaskGuideAttachmentInput[]
}

/**
 * Submit guidance once, then project the accepted event into its owning Chat.
 * The message is durable, but it is not a new Chat generation.
 */
export async function submitTaskGuidance({
  taskId,
  journeyId,
  text,
  attachments = []
}: SubmitTaskGuidanceInput): Promise<TaskGuideResult> {
  const guideTask = window.api.tasks?.guideTask
  if (!guideTask) {
    return {
      available: false,
      accepted: false,
      reason: 'Restart Off Grid AI to enable live guidance for new tasks.'
    }
  }

  const result = await guideTask(taskId, { text, attachments })
  if (!result.accepted || !journeyId || journeyId === taskId) return result

  const attachmentNames = attachments.map((attachment) => attachment.name)
  const chatContent =
    text || `Attached task guidance: ${attachmentNames.join(', ') || 'guidance attachment'}`
  const outcome = await executeWorkspaceContentCommand({
    type: 'append_message',
    conversationId: journeyId,
    portable: { role: 'user', content: chatContent },
    local: { taskGuidance: { taskId, state: 'accepted', attachmentNames } }
  })
  if (!outcome.ok) throw new Error(outcome.failure.message)
  const message = outcome.value.changes.find(
    (change) => change.kind === 'put' && change.entity === 'message'
  )
  if (!message) throw new Error('Chat could not confirm the saved guidance message.')
  window.dispatchEvent(
    new CustomEvent('og:task-guidance-message', { detail: { conversationId: journeyId } })
  )
  return result
}
