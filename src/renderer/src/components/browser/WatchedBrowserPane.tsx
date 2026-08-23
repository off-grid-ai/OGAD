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
import { X, DotsSixVertical } from '@phosphor-icons/react'

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
  const [takeover, setTakeover] = useState<TakeoverRequest | null>(null)
  const regionRef = useRef<HTMLDivElement>(null)
  // The split's width (px), drag-resizable from its left edge.
  const [paneWidth, setPaneWidth] = useState(() => Math.round(window.innerWidth * 0.42))

  useEffect(() => {
    const offState = window.api.browser?.onTaskState?.((event) => {
      const state = event as TaskState
      setTask(state)
      if (state.status === 'running') {
        setTakeover(null)
      }
    })
    const offTakeover = window.api.browser?.onTakeover?.((event) => {
      setTakeover(event as TakeoverRequest)
    })
    return () => {
      offState?.()
      offTakeover?.()
    }
  }, [])

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

  // Reserve the split's width on the app shell (App root reads this variable as
  // padding-right) so the content shrinks to the LEFT of the browser - a true
  // side-by-side split, not an overlay. Cleared when the pane is gone.
  useEffect(() => {
    const root = document.documentElement
    if (task) {
      root.style.setProperty('--browser-pane-width', `${paneWidth}px`)
    } else {
      root.style.removeProperty('--browser-pane-width')
    }
    return () => {
      root.style.removeProperty('--browser-pane-width')
    }
  }, [task, paneWidth])

  if (!task) {
    return null
  }

  const resolveTakeover = (outcome: 'resumed' | 'cancelled'): void => {
    if (takeover) {
      void window.api.browser?.resolveTakeover(takeover.taskId, outcome)
      setTakeover(null)
    }
  }

  // Drag the left edge to resize the split; width = distance from the right edge,
  // clamped so both the content and the browser stay usable.
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const onMove = (ev: MouseEvent): void => {
      const w = window.innerWidth - ev.clientX
      setPaneWidth(Math.max(360, Math.min(window.innerWidth - 280, w)))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Close: stop a running task and dismiss the pane, which hides the browser
  // view (null region) and un-shrinks the content.
  const close = (): void => {
    void window.api.vision?.control?.('stop')
    setTask(null)
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
      style={{ width: paneWidth }}
      className="fixed right-0 top-0 bottom-0 z-50 flex flex-col border-l border-neutral-800 bg-neutral-950 font-mono shadow-2xl"
    >
      {/* Drag handle: a full-height grab gutter on the left edge with a centered grip
          icon so it clearly reads as draggable. The web region below is inset by this
          width (ml-4) so the native WebContentsView never covers the gutter - otherwise
          the handle is only grabbable in the thin header strip. */}
      <div
        data-testid="watched-resize-handle"
        onMouseDown={startResize}
        className="group absolute top-0 bottom-0 left-0 z-20 flex w-4 cursor-ew-resize items-center justify-center bg-neutral-900/60 transition-colors hover:bg-green-500/20"
      >
        <DotsSixVertical
          weight="bold"
          className="h-4 w-4 text-neutral-600 transition-colors group-hover:text-green-500"
        />
      </div>
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-sm text-neutral-200">
          <span className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-green-500">
            Web task
          </span>
          <span className="truncate">{task.goal}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`text-[11px] uppercase tracking-wide ${statusTone}`}>{task.status}</span>
          <button
            onClick={close}
            aria-label="Close browser"
            data-testid="watched-close"
            className="rounded p-0.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
          >
            <X size={14} weight="bold" />
          </button>
        </div>
      </div>

      {/* The reserved region the main-process WebContentsView is laid over. Inset from
          the left (ml-4) so the resize handle's gutter stays uncovered and grabbable. */}
      <div
        ref={regionRef}
        data-testid="watched-web-region"
        className="relative ml-4 min-h-0 flex-1 border-b border-neutral-800 bg-neutral-900"
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
    </div>
  )
}
