/**
 * The grounder nudge, in the chat (R2-D1c). When a computer-use task runs on a
 * model that is not a GUI grounder, the main process warns via the vision
 * task-state feed. The supervisor overlay shows it in-run, but that panel is
 * easy to look past - so this surfaces the same warning in the chat flow, using
 * the shared MessageNudge look (the max-token cutoff bar).
 *
 * Deterministic (driven by the broadcast notice, not the model's phrasing) and
 * self-contained: it subscribes to the vision feed and renders nothing until a
 * non-grounder run reports a notice. Dismissable; a new task clears it.
 */
import { useEffect, useState } from 'react'
import { MessageNudge } from '@renderer/components/ui/MessageNudge'

interface TaskState {
  taskId: string
  notice?: string
}

export function VisionGrounderNudge(): React.JSX.Element | null {
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    // Queue time: the chat tool warns the moment a computer_task is queued on a
    // non-grounder, before the user approves.
    const offNotice = window.api.vision?.onNotice((event) => {
      setNotice((event as { notice?: string }).notice ?? null)
    })
    // Run time: a run raises its notice; a grounder run (no notice) clears a
    // stale nudge.
    const offState = window.api.vision?.onTaskState((event) => {
      setNotice((event as TaskState).notice ?? null)
    })
    return () => {
      offNotice?.()
      offState?.()
    }
  }, [])

  if (!notice) {
    return null
  }

  return (
    <div className="mx-3 mb-2">
      <MessageNudge onDismiss={() => setNotice(null)}>{notice}</MessageNudge>
    </div>
  )
}
