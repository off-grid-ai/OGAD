import { appendTaskStep, getTaskExecutionDevice, getTaskRun } from './task-history'
import {
  isTaskGuideAttachmentNameAllowed,
  TASK_GUIDE_MAX_ATTACHMENTS,
  TASK_GUIDE_MAX_ATTACHMENT_BYTES,
  TASK_GUIDE_MAX_ATTACHMENT_TEXT_CHARS,
  TASK_GUIDE_MAX_TEXT_CHARS,
  TASK_GUIDE_MAX_TOTAL_ATTACHMENT_BYTES,
  TASK_GUIDE_MAX_TOTAL_ATTACHMENT_TEXT_CHARS,
  type TaskGuideAttachmentInput,
  type TaskGuideInput
} from '../../shared/task-guidance'

export interface TaskGuideAvailability {
  available: boolean
  reason?: string
}

export interface TaskGuideResult extends TaskGuideAvailability {
  accepted?: boolean
}

export type TaskGuideHandler = (text: string) => Promise<boolean> | boolean
export const TASK_GUIDANCE_TRACE = 'GUIDANCE ACCEPTED · Applying to the next decision.'
export const TASK_GUIDANCE_APPLIED_TRACE = 'GUIDANCE APPLIED · Used for the next decision.'

export function persistedTaskGuidanceTrace(): string {
  return TASK_GUIDANCE_TRACE
}

const handlers = new Map<string, TaskGuideHandler>()

function bytesOf(attachment: TaskGuideAttachmentInput): Uint8Array | null {
  if (attachment.bytes instanceof ArrayBuffer) return new Uint8Array(attachment.bytes)
  if (ArrayBuffer.isView(attachment.bytes)) {
    return new Uint8Array(
      attachment.bytes.buffer,
      attachment.bytes.byteOffset,
      attachment.bytes.byteLength
    )
  }
  return null
}

function safeAttachmentName(name: string): string {
  return (
    name
      .replace(/\\/g, '/')
      .split('/')
      .at(-1)
      ?.replace(/[\u0000-\u001f\u007f]/g, '_')
      .slice(0, 180)
      .trim() ?? ''
  )
}

async function attachmentGuidance(
  attachments: readonly TaskGuideAttachmentInput[]
): Promise<{ context?: string; reason?: string }> {
  if (attachments.length > TASK_GUIDE_MAX_ATTACHMENTS) {
    return { reason: `Attach up to ${TASK_GUIDE_MAX_ATTACHMENTS} files at a time.` }
  }
  const accepted: Array<{ name: string; bytes: Uint8Array }> = []
  let totalBytes = 0
  for (const attachment of attachments) {
    if (!attachment || typeof attachment.name !== 'string') {
      return { reason: 'One attachment is not valid.' }
    }
    const name = safeAttachmentName(attachment.name)
    const bytes = bytesOf(attachment)
    if (!name || !isTaskGuideAttachmentNameAllowed(name) || !bytes) {
      return { reason: `${name || 'This file'} is not a supported guidance attachment.` }
    }
    if (bytes.byteLength === 0) return { reason: `${name} is empty.` }
    if (bytes.byteLength > TASK_GUIDE_MAX_ATTACHMENT_BYTES) {
      return { reason: `${name} is larger than 5 MB.` }
    }
    totalBytes += bytes.byteLength
    if (totalBytes > TASK_GUIDE_MAX_TOTAL_ATTACHMENT_BYTES) {
      return { reason: 'Guidance attachments must total 12 MB or less.' }
    }
    accepted.push({ name, bytes })
  }
  if (!accepted.length) return {}

  const { processUpload } = await import('../files')
  const sections: string[] = []
  let remaining = TASK_GUIDE_MAX_TOTAL_ATTACHMENT_TEXT_CHARS
  for (const attachment of accepted) {
    try {
      const processed = await processUpload(attachment.name, attachment.bytes, {
        persistPreview: false,
        captionImage: true
      })
      const content = processed.text.trim()
      if (!content) return { reason: `${attachment.name} did not contain readable content.` }
      const bounded = content.slice(0, Math.min(TASK_GUIDE_MAX_ATTACHMENT_TEXT_CHARS, remaining))
      if (!bounded) return { reason: 'The attachment text limit was reached.' }
      remaining -= bounded.length
      sections.push(
        `Attached ${processed.kind} file ${JSON.stringify(attachment.name)}:\n${bounded}`
      )
    } catch {
      return { reason: `${attachment.name} could not be read on this device.` }
    }
  }
  return { context: sections.join('\n\n') }
}

export function registerTaskGuideHandler(taskId: string, handler: TaskGuideHandler): () => void {
  handlers.set(taskId, handler)
  return () => {
    if (handlers.get(taskId) === handler) handlers.delete(taskId)
  }
}

export function taskGuideAvailability(taskId: string): TaskGuideAvailability {
  const task = getTaskRun(taskId)
  if (!task) return { available: false, reason: 'This task is no longer in history.' }
  if (!['running', 'paused', 'waiting', 'reconnecting'].includes(task.status))
    return { available: false, reason: 'Only a live task can accept guidance.' }
  const device = getTaskExecutionDevice()
  if (task.executionDeviceId && task.executionDeviceId !== device.id) {
    return {
      available: false,
      reason: `Guide this task on ${task.executionDeviceName || 'its execution device'}.`
    }
  }
  if (!handlers.has(taskId))
    return { available: false, reason: 'This task cannot accept guidance yet.' }
  return { available: true }
}

export async function guideTask(taskId: string, input: TaskGuideInput): Promise<TaskGuideResult> {
  const guidance = typeof input.text === 'string' ? input.text.trim() : ''
  const attachments = Array.isArray(input.attachments) ? input.attachments : []
  if (!guidance && attachments.length === 0)
    return { available: false, reason: 'Enter guidance or attach a file before sending.' }
  if (guidance.length > TASK_GUIDE_MAX_TEXT_CHARS)
    return { available: false, reason: 'Guidance must be 2,000 characters or less.' }
  const availability = taskGuideAvailability(taskId)
  if (!availability.available) return availability
  const attachmentResult = await attachmentGuidance(attachments)
  if (attachmentResult.reason) {
    return { available: true, accepted: false, reason: attachmentResult.reason }
  }
  const inMemoryGuidance = [guidance, attachmentResult.context].filter(Boolean).join('\n\n')
  const accepted = await handlers.get(taskId)!(inMemoryGuidance)
  if (!accepted)
    return {
      available: true,
      accepted: false,
      reason: 'The running task did not accept this guidance.'
    }
  // The exact guidance is consumed from memory by the running task. Persisting it would put
  // pasted passwords, tokens, or private text into task history and cross-device sync.
  const task = getTaskRun(taskId)!
  const trace = persistedTaskGuidanceTrace()
  // Web Use updates its live local trace inside the handler before returning.
  // Do not append the same accepted event again at the API boundary.
  if (task.steps.at(-1) !== trace) appendTaskStep(taskId, task.kind, task.title, trace)
  return { available: true, accepted: true }
}

export function resetTaskGuideHandlersForTests(): void {
  handlers.clear()
}

export function hasTaskGuideHandlerForTests(taskId: string): boolean {
  return handlers.has(taskId)
}
