import type { TaskSession } from './task-session-store'
import type { ChatQueues } from './chat-queue-store'
import type { TurnPersistence } from './chat-turn-persistence'
import type { RunEvent } from './chat-run-owner'
import { clearQueue } from './chat-queue'
import {
  captureStopTarget,
  preparingRunIds,
  targetRun,
  type RunStopTarget
} from './chat-run-lifecycle'
import { stopFailureMessage } from '../components/MemoryChat/utlis'
export interface StopDependencies extends Pick<
  TurnPersistence,
  | 'streamConvRef'
  | 'messagesByConvRef'
  | 'answerByStream'
  | 'reasoningByStream'
  | 'timelineByStream'
  | 'toolCallsByStream'
> {
  activeConversationId: string | null
  cancelledRef: { current: Set<string> }
  queuedRef: { current: ChatQueues }
  setQueuedByConv: (queues: ChatQueues) => void
  stopLiveTask: (task: Pick<TaskSession, 'taskId' | 'journeyId' | 'kind'>) => Promise<boolean>
  setAttachWarn: (warning: string | null) => void
  dispatch: (detail: RunEvent) => void
  cancelRag: (id: string) => void
  finalizeStoppedTurn: (cid: string, sid: string) => Promise<void>
  markGenerating: (cid: string, on: boolean) => void
  drainQueue: (cid: string) => void
  imageGenConv: string | null
  cancelImageGen: () => void
  setImageGenConv: (cid: string | null) => void
  setImgProgress: (progress: null) => void
  setLoading: (loading: boolean) => void
}
export async function stopChatRun(
  dependencies: StopDependencies,
  cid: string | null,
  task: Pick<TaskSession, 'taskId' | 'journeyId' | 'kind'> | null,
  preserveQueue = false,
  requestedTarget?: RunStopTarget
): Promise<void> {
  const {
    activeConversationId,
    cancelledRef,
    streamConvRef,
    messagesByConvRef,
    queuedRef,
    setQueuedByConv,
    setAttachWarn,
    answerByStream,
    reasoningByStream,
    timelineByStream,
    toolCallsByStream,
    dispatch,
    cancelRag,
    finalizeStoppedTurn,
    markGenerating,
    drainQueue,
    imageGenConv,
    cancelImageGen,
    setImageGenConv,
    setImgProgress,
    setLoading
  } = dependencies
  const convId = cid ?? activeConversationId
  if (!convId) return
  const { runId: cancelledRunId, streamId: streamingId } =
    requestedTarget ??
    captureStopTarget(streamConvRef.current, messagesByConvRef.current[convId] ?? [], convId)
  if (requestedTarget && targetRun(streamConvRef.current, convId) !== cancelledRunId) return
  if (!preserveQueue && queuedRef.current[convId]?.length) {
    queuedRef.current = clearQueue(queuedRef.current, convId)
    setQueuedByConv({ ...queuedRef.current })
  }
  const preparationIds = preparingRunIds(streamConvRef.current, convId)
  const preparing = preparationIds.length > 0
  for (const id of preparationIds) cancelledRef.current.add(id)
  if (!(await stopTaskBeforeCancel(dependencies, task, convId))) return
  setAttachWarn(null)
  const detail: RunEvent = {
    action: 'cancel',
    conversationId: convId,
    preserveQueue,
    runId: cancelledRunId,
    stream: streamingId
      ? {
          id: streamingId,
          answer: answerByStream.current[streamingId] ?? '',
          reasoning: reasoningByStream.current[streamingId] ?? '',
          timeline: timelineByStream.current[streamingId],
          tools: toolCallsByStream.current[streamingId]
        }
      : undefined
  }
  dispatch(detail)
  if (targetRun(streamConvRef.current, convId) !== cancelledRunId) return
  // Abort the answer on screen even when a run claimed the cancel: the claiming run can be an
  // older one in this conversation that cancels its own finished stream, and the answer kept
  // streaming until a tab switch remounted the view. A second abort of the same stream is a no-op.
  if (streamingId) cancelRag(streamingId)
  if (streamingId && !detail.claimed) {
    cancelledRef.current.add(convId)
    await finalizeStoppedTurn(convId, streamingId)
    markGenerating(convId, false)
    cancelledRef.current.delete(convId)
    if (preserveQueue) drainQueue(convId)
  }
  // The sender owns the final save, including after a navigation/remount.
  // Preparation likewise keeps its reservation until pending storage writes settle.
  if (!preserveQueue && !preparing && !detail.claimed) markGenerating(convId, false)
  // Cancel + clear the image job ONLY if THIS conversation owns it, so stopping
  // one conversation never kills another's in-flight image (D9). imgProgress is a
  // shared stream buffer — clear it too when the owner stops.
  if (imageGenConv === convId) {
    cancelImageGen()
    setImageGenConv(null)
    setImgProgress(null)
  }
  // `loading` is the foreground send-flag; clear it when stopping the conversation
  // on screen (the only conversation whose composer is visible).
  if (convId === activeConversationId) setLoading(false)
}

async function stopTaskBeforeCancel(
  dependencies: StopDependencies,
  task: Pick<TaskSession, 'taskId' | 'journeyId' | 'kind'> | null,
  convId: string
): Promise<boolean> {
  if (task?.journeyId !== convId) return true
  {
    try {
      const stopped = await dependencies.stopLiveTask(task)
      if (!stopped) {
        dependencies.cancelledRef.current.delete(convId)
        dependencies.setAttachWarn(stopFailureMessage(task.kind))
        return false
      }
    } catch (error) {
      dependencies.cancelledRef.current.delete(convId)
      console.error(`Failed to stop ${task.kind} task ${task.taskId}:`, error)
      dependencies.setAttachWarn(stopFailureMessage(task.kind))
      return false
    }
  }
  return true
}
