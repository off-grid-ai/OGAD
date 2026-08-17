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
    const off = window.api.vision?.onTaskState((event) => {
      const state = event as TaskState
      // A run with a notice raises it; a run without one clears a stale nudge.
      setNotice(state.notice ?? null)
    })
    return () => off?.()
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
