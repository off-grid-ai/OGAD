import type { TaskGuideAttachmentInput } from '../../../shared/task-guidance'

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
 * The projection is durable and synced, but it is not a new Chat generation.
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
  await window.api.addRagMessage(journeyId, 'user', chatContent, {
    taskGuidance: { taskId, state: 'accepted', attachmentNames }
  })
  window.dispatchEvent(
    new CustomEvent('og:task-guidance-message', { detail: { conversationId: journeyId } })
  )
  return result
}
