/**
 * The watched pane (R2-C2): a right-side slide-over that shows a web task as
 * it runs - the live step feed - and, at the identity boundary, hands control
 * to the user with a takeover prompt (Resume / Cancel). It reuses the
 * ArtifactCanvas slide-over layout so the two panes read as one system.
 *
 * The live page itself is rendered by a main-process WebContentsView laid over
 * the reserved region below; this component owns the chrome, the narration,
 * and the handoff. Self-contained: it subscribes to the browser IPC feed and
 * renders nothing until a task is running.
 */
import { useEffect, useRef, useState } from 'react'

interface StepEvent {
  taskId: string
  note: string
}

interface TakeoverRequest {
  taskId: string
  why: string
}

interface TaskState {
  taskId: string
  goal: string
  status: 'running' | 'done' | 'failed'
  summary?: string
}

export function WatchedBrowserPane(): React.JSX.Element | null {
  const [task, setTask] = useState<TaskState | null>(null)
  const [steps, setSteps] = useState<string[]>([])
  const [takeover, setTakeover] = useState<TakeoverRequest | null>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const regionRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const offState = window.api.browser?.onTaskState((event) => {
      const state = event as TaskState
      setTask(state)
      if (state.status === 'running') {
        setSteps([])
        setTakeover(null)
      }
    })
    const offStep = window.api.browser?.onStep((event) => {
      const step = event as StepEvent
      setSteps((current) => [...current, step.note])
    })
    const offTakeover = window.api.browser?.onTakeover((event) => {
      setTakeover(event as TakeoverRequest)
    })
    return () => {
      offState?.()
      offStep?.()
      offTakeover?.()
    }
  }, [])

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight })
  }, [steps])

  // Report the reserved region to main so the live WebContentsView docks exactly
  // to it (and hide the view when the pane goes away) - keyed on the task so it
  // re-measures when the region first appears. The pane is `fixed`, so the rect
  // only moves on window resize, which the observer + listener catch.
  useEffect(() => {
    const el = regionRef.current
    if (!el) {
      return
    }
    const report = (): void => {
      const r = el.getBoundingClientRect()
      window.api.browser?.setRegion?.({
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      window.api.browser?.setRegion?.(null) // hide the view when the pane unmounts
    }
  }, [task?.taskId])

  if (!task) {
    return null
  }

  const resolveTakeover = (outcome: 'resumed' | 'cancelled'): void => {
    if (takeover) {
      void window.api.browser?.resolveTakeover(takeover.taskId, outcome)
      setTakeover(null)
    }
  }

  const statusTone =
    task.status === 'done'
      ? 'text-green-500'
      : task.status === 'failed'
        ? 'text-red-500'
        : 'text-neutral-400'

  return (
    <div
      data-testid="watched-browser-pane"
      className="fixed right-0 top-0 bottom-0 z-50 flex w-[42vw] min-w-[420px] max-w-[90vw] flex-col border-l border-neutral-800 bg-neutral-950 font-mono shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm text-neutral-200">
          <span className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-green-500">
            Web task
          </span>
          <span className="truncate">{task.goal}</span>
        </div>
        <span className={`text-[11px] uppercase tracking-wide ${statusTone}`}>{task.status}</span>
      </div>

      {/* The reserved region the main-process WebContentsView is laid over. */}
      <div
        ref={regionRef}
        data-testid="watched-web-region"
        className="relative min-h-0 flex-1 border-b border-neutral-800 bg-neutral-900"
      >
        {takeover && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-neutral-950/95 p-6 text-center">
            <span className="rounded-sm border border-amber-500/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-500">
              Your turn
            </span>
            <p className="max-w-sm text-sm text-neutral-200">{takeover.why}</p>
            <p className="max-w-sm text-xs text-neutral-500">
              Sign in or confirm directly in the page above. Off Grid never sees your password or
              codes. Resume when you are done.
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => resolveTakeover('resumed')}
                className="rounded-md bg-green-500 px-4 py-1.5 text-xs font-medium text-black transition-all duration-150 active:scale-95"
              >
                Resume
              </button>
              <button
                onClick={() => resolveTakeover('cancelled')}
                className="rounded-md border border-neutral-700 px-4 py-1.5 text-xs text-neutral-300 transition-colors hover:text-white"
              >
                Cancel task
              </button>
            </div>
          </div>
        )}
      </div>

      <div
        ref={feedRef}
        data-testid="watched-step-feed"
        className="max-h-48 shrink-0 overflow-y-auto px-4 py-2 text-xs text-neutral-400"
      >
        {steps.length === 0 ? (
          <span className="text-neutral-600">Starting…</span>
        ) : (
          steps.map((note, i) => (
            <div key={i} className="py-0.5">
              <span className="mr-2 text-neutral-600">{String(i + 1).padStart(2, '0')}</span>
              {note}
            </div>
          ))
        )}
        {task.status !== 'running' && task.summary && (
          <div className={`mt-1 py-0.5 ${statusTone}`}>{task.summary}</div>
        )}
      </div>
    </div>
  )
}
