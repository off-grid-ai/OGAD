/**
 * The computer-use supervisor PANEL, rendered in its own floating always-on-top
 * window (the `#cu-supervisor` surface). While the AX/vision rail drives another
 * app, Off Grid's main window drops behind it - so the in-app overlay would be
 * hidden. This panel lives in a separate NSPanel that stays over whatever is
 * being driven, so the user always sees what the agent is doing and can stop it.
 *
 * Same feed as the in-app VisionSupervisorOverlay (subscribes to the vision
 * task-state + step events the rail broadcasts), laid out to FILL the small
 * window. Adds a live "thinking (Ns)" timer since the last step so a slow model
 * decide reads as "working", not "stuck".
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
  notice?: string
}

const STATUS_TONE: Record<string, string> = {
  running: 'text-green-500',
  paused: 'text-amber-500',
  done: 'text-green-500',
  failed: 'text-red-500'
}

export function ComputerUseSupervisor(): React.JSX.Element {
  const [task, setTask] = useState<TaskState | null>(null)
  const [steps, setSteps] = useState<string[]>([])
  // Seconds since the last step arrived - drives the "thinking (Ns)" line so a
  // long model decide never looks frozen.
  const [sinceStep, setSinceStep] = useState(0)
  const feedRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let mounted = true
    // Subscribe FIRST (synchronously) so no live event is missed, then fetch the
    // history the window opened too late to hear (the buffered current run).
    const offState = window.api.vision?.onTaskState((event) => {
      const state = event as TaskState
      setTask((current) => {
        if (current?.taskId !== state.taskId) {
          setSteps([])
        }
        return state
      })
      setSinceStep(0)
    })
    const offStep = window.api.vision?.onStep((event) => {
      setSteps((current) => [...current, (event as StepEvent).note])
      setSinceStep(0)
    })
    void window.api.vision?.getCurrent?.().then((cur) => {
      if (!mounted || !cur?.state) {
        return
      }
      setTask((t) => t ?? (cur.state as TaskState))
      // Use the buffer only if it's at least as complete as what live gave us,
      // so a step that raced in during the fetch is not clobbered.
      setSteps((s) => (cur.steps && cur.steps.length >= s.length ? cur.steps : s))
    })
    return () => {
      mounted = false
      offState?.()
      offStep?.()
    }
  }, [])

  const running = task?.status === 'running' || task?.status === 'paused'

  // Tick the "thinking" timer once a second while the task is running.
  useEffect(() => {
    if (!running) {
      return
    }
    const id = setInterval(() => setSinceStep((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [running, task?.taskId])

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight })
  }, [steps, sinceStep])

  const control = (command: 'stop' | 'pause' | 'resume'): void => {
    void window.api.vision?.control(command)
  }

  const tone = task ? (STATUS_TONE[task.status] ?? 'text-neutral-400') : 'text-neutral-400'

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-neutral-950 font-mono text-neutral-200 select-none">
      {/* Header - draggable so the panel can be repositioned. */}
      <div
        className="flex items-center justify-between border-b border-neutral-800 px-3 py-2"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-green-500">
          Computer use
        </span>
        <span className={`text-[10px] uppercase tracking-wide ${tone}`}>
          {task?.status ?? 'idle'}
        </span>
      </div>

      {task ? (
        <>
          <div className="border-b border-neutral-800 px-3 py-2 text-xs text-neutral-300">
            {task.goal}
          </div>

          {task.notice && (
            <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-500">
              {task.notice}
            </div>
          )}

          <div
            ref={feedRef}
            className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[11px] leading-relaxed text-neutral-400"
          >
            {steps.length === 0 && !running ? (
              <span className="text-neutral-600">Starting…</span>
            ) : (
              steps.map((note, i) => (
                <div key={i} className="py-0.5">
                  <span className="mr-2 text-neutral-600">{String(i + 1).padStart(2, '0')}</span>
                  {note}
                </div>
              ))
            )}
            {running && (
              <div className="flex items-center gap-2 py-1 text-green-500">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
                <span>
                  {task.status === 'paused'
                    ? 'paused - waiting for you'
                    : `thinking… (${sinceStep}s)`}
                </span>
              </div>
            )}
            {!running && task.summary && (
              <div className={`mt-1 py-0.5 ${tone}`}>{task.summary}</div>
            )}
          </div>

          <div
            className="flex items-center gap-2 border-t border-neutral-800 px-3 py-2.5"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {running ? (
              <>
                <button
                  onClick={() => control('stop')}
                  className="rounded-md bg-red-500 px-3 py-1.5 text-[11px] font-medium text-black transition-all duration-150 active:scale-95"
                >
                  Stop
                </button>
                {task.status === 'paused' ? (
                  <button
                    onClick={() => control('resume')}
                    className="rounded-md border border-neutral-700 px-3 py-1.5 text-[11px] text-neutral-300 transition-colors hover:text-white"
                  >
                    Resume
                  </button>
                ) : (
                  <button
                    onClick={() => control('pause')}
                    className="rounded-md border border-neutral-700 px-3 py-1.5 text-[11px] text-neutral-300 transition-colors hover:text-white"
                  >
                    Pause
                  </button>
                )}
                <span className="ml-auto text-[10px] text-neutral-600">Esc to take over</span>
              </>
            ) : (
              <span className="text-[10px] text-neutral-600">Task finished</span>
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center text-[11px] text-neutral-600">
          Waiting for a task…
        </div>
      )}
    </div>
  )
}
