/**
 * The vision rail's supervisor overlay (R2-D2b UX half): while a supervised
 * computer-use task runs on the live desktop, this shows what it is doing and
 * puts a Stop and a Pause in reach. It reuses the ArtifactCanvas / watched-pane
 * slide-over layout so the supervised surfaces read as one system.
 *
 * The kill switch is also a global Esc in the host; this Stop routes to the
 * same guard. Self-contained: it subscribes to the vision feed and renders
 * nothing until a task is running.
 */
import { useEffect, useRef, useState } from 'react'

interface StepEvent {
  taskId: string
  note: string
}

interface TaskState {
  taskId: string
  goal: string
  status: 'running' | 'paused' | 'done' | 'failed'
  summary?: string
}

const STATUS_TONE: Record<string, string> = {
  running: 'text-green-500',
  paused: 'text-amber-500',
  done: 'text-green-500',
  failed: 'text-red-500'
}

export function VisionSupervisorOverlay(): React.JSX.Element | null {
  const [task, setTask] = useState<TaskState | null>(null)
  const [steps, setSteps] = useState<string[]>([])
  const feedRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const offState = window.api.vision?.onTaskState((event) => {
      const state = event as TaskState
      // A new task id clears the previous run's feed; a status change on the
      // same task keeps it.
      setTask((current) => {
        if (current?.taskId !== state.taskId) {
          setSteps([])
        }
        return state
      })
    })
    const offStep = window.api.vision?.onStep((event) => {
      setSteps((current) => [...current, (event as StepEvent).note])
    })
    return () => {
      offState?.()
      offStep?.()
    }
  }, [])

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight })
  }, [steps])

  if (!task) {
    return null
  }

  const control = (command: 'stop' | 'pause' | 'resume'): void => {
    void window.api.vision?.control(command)
  }

  const tone = STATUS_TONE[task.status] ?? 'text-neutral-400'
  const running = task.status === 'running' || task.status === 'paused'

  return (
    <div
      data-testid="vision-supervisor-overlay"
      className="fixed right-0 top-0 bottom-0 z-50 flex w-[34vw] min-w-[360px] max-w-[90vw] flex-col border-l border-neutral-800 bg-neutral-950 font-mono shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm text-neutral-200">
          <span className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-green-500">
            Computer use
          </span>
          <span className="truncate">{task.goal}</span>
        </div>
        <span className={`text-[11px] uppercase tracking-wide ${tone}`}>{task.status}</span>
      </div>

      <div className="border-b border-neutral-800 px-4 py-2 text-xs text-neutral-500">
        Off Grid is acting on your screen. Move the mouse or press Esc to take over at any time.
      </div>

      <div
        ref={feedRef}
        data-testid="vision-step-feed"
        className="min-h-0 flex-1 overflow-y-auto px-4 py-2 text-xs text-neutral-400"
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
        {!running && task.summary && <div className={`mt-1 py-0.5 ${tone}`}>{task.summary}</div>}
      </div>

      {running && (
        <div className="flex items-center gap-2 border-t border-neutral-800 px-4 py-3">
          <button
            onClick={() => control('stop')}
            className="rounded-md bg-red-500 px-4 py-1.5 text-xs font-medium text-black transition-all duration-150 active:scale-95"
          >
            Stop
          </button>
          {task.status === 'paused' ? (
            <button
              onClick={() => control('resume')}
              className="rounded-md border border-neutral-700 px-4 py-1.5 text-xs text-neutral-300 transition-colors hover:text-white"
            >
              Resume
            </button>
          ) : (
            <button
              onClick={() => control('pause')}
              className="rounded-md border border-neutral-700 px-4 py-1.5 text-xs text-neutral-300 transition-colors hover:text-white"
            >
              Pause
            </button>
          )}
        </div>
      )}
    </div>
  )
}
