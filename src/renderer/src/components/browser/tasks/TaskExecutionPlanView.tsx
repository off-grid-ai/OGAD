import { CheckCircle, Circle, WarningCircle } from '@phosphor-icons/react'
import { useState } from 'react'
import {
  decodeTaskPhase,
  isTaskPlanControlStep,
  taskExecutionPlanProgress,
  type TaskExecutionPlan
} from '../../../../../shared/task-execution-plan'
import type { TaskTab } from './task-types'
import { captureUrlForPath } from '../../../../../shared/ogcapture-url'
import { createBrowserCoordinateTransform } from '../../../../../shared/browser-coordinate-transform'

function mappedActionDescriptions(serialized?: string): string[] {
  if (!serialized) return []
  try {
    const value = JSON.parse(serialized) as unknown
    const actions = Array.isArray(value) ? value : [value]
    return actions.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object') return []
      const action = candidate as Record<string, unknown>
      const type = String(action.type ?? '')
      const point = action.point as { x?: number; y?: number } | undefined
      if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
        const verb =
          type === 'click'
            ? 'click'
            : type === 'mouse_move'
              ? 'move to'
              : type.replace('_click', ' click')
        return [`${verb} at (${point.x}, ${point.y})`]
      }
      if (type === 'type') return ['type text']
      if (type === 'hotkey') return [`hotkey ${String(action.keys ?? '')}`]
      if (type === 'press') {
        const keys = Array.isArray(action.keys) ? action.keys.join(' ') : String(action.keys ?? '')
        return [`press ${keys}`]
      }
      if (type === 'scroll_by') {
        return [`scroll ${String(action.axis ?? 'vertical')} by ${String(action.amount ?? '')}`]
      }
      return []
    })
  } catch {
    return []
  }
}

function modelIntent(modelOutput?: string): string | undefined {
  if (!modelOutput) return undefined
  const tagged = modelOutput.match(/<action\b[^>]*>([\s\S]*?)<\/action>/i)?.[1]
  const value = (tagged ?? modelOutput.split(/<tool_call\b/i)[0] ?? '')
    .replace(/<\/?action\b[^>]*>/gi, '')
    .trim()
  return value || undefined
}

type TraceActionKind =
  | 'click'
  | 'move'
  | 'type'
  | 'hotkey'
  | 'press'
  | 'scroll'
  | 'rejected'
  | 'milestone'

function traceActionKind(step: string): TraceActionKind | null {
  if (step.startsWith('milestone complete:')) return 'milestone'
  if (step.startsWith('rejected action:')) return 'rejected'
  if (/^(?:click|double click|right click|middle click|triple click) at /.test(step)) return 'click'
  if (step.startsWith('move to ')) return 'move'
  if (step === 'type text' || step.startsWith('typed ')) return 'type'
  if (step.startsWith('hotkey ')) return 'hotkey'
  if (step.startsWith('press ')) return 'press'
  if (step.startsWith('scroll ')) return 'scroll'
  return null
}

interface StepEvidence {
  path: string
  descriptions: string[]
  decisionSummary?: string
  decisionRationale?: string
  modelOutput?: string
  mappedAction?: string
  executionResult?: string
  executionError?: string
  durationMs?: number
  rejection?: string
  point?: { x: number; y: number }
  frame: { width: number; height: number; coordinateWidth: number; coordinateHeight: number }
  used: boolean
}

function mappedActionPoint(serialized?: string): { x: number; y: number } | undefined {
  if (!serialized) return undefined
  try {
    const value = JSON.parse(serialized) as unknown
    const candidate = Array.isArray(value) ? value[0] : value
    if (!candidate || typeof candidate !== 'object') return undefined
    const point = (candidate as { point?: { x?: number; y?: number } }).point
    return point && Number.isFinite(point.x) && Number.isFinite(point.y)
      ? { x: Number(point.x), y: Number(point.y) }
      : undefined
  } catch {
    return undefined
  }
}

function evidenceMarkerPercent(evidence: StepEvidence): { x: number; y: number } | undefined {
  if (!evidence.point) return undefined
  return createBrowserCoordinateTransform({
    encoded: { width: evidence.frame.width, height: evidence.frame.height },
    surface: { width: evidence.frame.coordinateWidth, height: evidence.frame.coordinateHeight },
    page: {
      x: 0,
      y: 0,
      width: evidence.frame.coordinateWidth,
      height: evidence.frame.coordinateHeight
    },
    capture: { width: evidence.frame.width, height: evidence.frame.height }
  }).surfaceToCapturePercent(evidence.point)
}

interface PhaseTrace {
  id: string
  title: string
  steps: string[]
}

function phaseTrace(
  task: TaskTab
): { plan: TaskExecutionPlan; phases: PhaseTrace[]; active: number } | null {
  const progress = taskExecutionPlanProgress(task.steps)
  if (!progress) return null
  const { plan, activePhaseIndex } = progress
  const phases = plan.phases.map((phase) => ({ ...phase, steps: [] as string[] }))
  let active = 0
  for (const step of task.steps) {
    const phaseId = decodeTaskPhase(step)
    if (phaseId) {
      const index = phases.findIndex((phase) => phase.id === phaseId)
      // A model can mention an earlier phase again while it corrects an action.
      // Progress is monotonic: revisiting a phase must not make completed work
      // look incomplete or move the counter backwards.
      if (index >= 0) active = Math.max(active, index)
      continue
    }
    if (isTaskPlanControlStep(step)) continue
    phases[active]?.steps.push(step)
  }
  return { plan, phases, active: activePhaseIndex }
}

function phaseState(
  task: TaskTab,
  index: number,
  active: number
): 'complete' | 'active' | 'failed' | 'upcoming' {
  // A terminal task state does not prove that every planned stage ran. Only
  // phase markers may advance the execution plan.
  if (task.status === 'done') return index <= active ? 'complete' : 'upcoming'
  if (index < active) return 'complete'
  if (index > active) return 'upcoming'
  return task.status === 'failed' ? 'failed' : 'active'
}

function StepLine({
  step,
  index,
  guidanceMessage,
  evidence,
  showDecisionDetails,
  selected,
  onSelect
}: {
  step: string
  index: number
  guidanceMessage?: string
  evidence?: StepEvidence
  showDecisionDetails: boolean
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const guidance =
    step.startsWith('USER GUIDANCE · ') ||
    step.startsWith('GUIDANCE ACCEPTED · ') ||
    step.startsWith('GUIDANCE APPLIED · ')
  const guidanceText = step.startsWith('GUIDANCE APPLIED · ')
    ? 'Applied to the next decision.'
    : 'Accepted. Applying to the next decision.'
  const marker = evidence ? evidenceMarkerPercent(evidence) : undefined
  return (
    <li className="border-t border-border/70 py-2 text-[10px] leading-4 text-muted-foreground">
      <button
        type="button"
        onClick={onSelect}
        disabled={!evidence?.path}
        className="block w-full text-left disabled:cursor-default"
      >
        <span className="mr-2 text-green-500">{index + 1}</span>
        {guidance ? (
          <>
            <span className="mr-1.5 border border-green-500/40 px-1 py-0.5 text-[8px] uppercase tracking-wide text-green-500">
              User guidance
            </span>
            {guidanceMessage || guidanceText}
          </>
        ) : (
          step
        )}
      </button>
      {showDecisionDetails && evidence?.decisionSummary ? (
        <p className="mt-1 pl-5 text-[9px] leading-4 text-foreground/80">
          <span className="text-muted-foreground">Decision: </span>
          {evidence.decisionSummary}
        </p>
      ) : null}
      {showDecisionDetails && evidence?.decisionRationale ? (
        <p className="mt-1 pl-5 text-[9px] leading-4 text-foreground/80">
          <span className="text-muted-foreground">
            {traceActionKind(step) === 'milestone' ? 'Visible evidence: ' : 'Why this action: '}
          </span>
          {evidence.decisionRationale}
        </p>
      ) : null}
      {showDecisionDetails && evidence ? (
        <details className="mt-1 pl-5 text-[9px] text-muted-foreground">
          <summary className="cursor-pointer select-none hover:text-foreground">
            Model details
          </summary>
          <dl className="mt-1.5 grid gap-px overflow-hidden border border-border bg-border sm:grid-cols-2">
            {modelIntent(evidence.modelOutput) ? (
              <div className="bg-background px-2.5 py-2">
                <dt className="uppercase tracking-wide">Model intent</dt>
                <dd className="mt-1 whitespace-pre-wrap break-words leading-4 text-foreground">
                  {modelIntent(evidence.modelOutput)}
                </dd>
              </div>
            ) : null}
            {evidence.descriptions.length ? (
              <div className="bg-background px-2.5 py-2">
                <dt className="uppercase tracking-wide">Executed action</dt>
                <dd className="mt-1 text-foreground">{evidence.descriptions.join('; ')}</dd>
              </div>
            ) : null}
            {evidence.executionResult || evidence.executionError ? (
              <div className="bg-background px-2.5 py-2">
                <dt className="uppercase tracking-wide">Result</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-1.5 text-foreground">
                  <span
                    className={`border px-1.5 py-0.5 uppercase tracking-wide ${evidence.executionError ? 'border-red-500/40 text-red-500' : 'border-green-500/40 text-green-500'}`}
                  >
                    {evidence.executionError ? 'Failed' : evidence.executionResult}
                  </span>
                  {evidence.durationMs !== undefined ? (
                    <span className="text-muted-foreground">
                      {(evidence.durationMs / 1000).toFixed(1)}s
                    </span>
                  ) : null}
                  {evidence.executionError ? (
                    <span className="basis-full leading-4 text-red-500">
                      {evidence.executionError}
                    </span>
                  ) : null}
                </dd>
              </div>
            ) : null}
          </dl>
          {evidence.modelOutput || evidence.mappedAction ? (
            <details className="mt-1.5 border border-border bg-background px-2.5 py-2">
              <summary className="cursor-pointer select-none uppercase tracking-wide hover:text-foreground">
                Technical payload
              </summary>
              {evidence.modelOutput ? (
                <pre className="mt-2 whitespace-pre-wrap break-words border-t border-border pt-2 font-mono leading-4 text-foreground/70">
                  {evidence.modelOutput}
                </pre>
              ) : null}
              {evidence.mappedAction ? (
                <pre className="mt-2 whitespace-pre-wrap break-all border-t border-border pt-2 font-mono leading-4 text-foreground/70">
                  {evidence.mappedAction}
                </pre>
              ) : null}
            </details>
          ) : null}
        </details>
      ) : null}
      {evidence?.path ? (
        <div
          className="relative mt-2 w-full overflow-hidden border border-border bg-black"
          style={{ aspectRatio: `${evidence.frame.width} / ${evidence.frame.height}` }}
        >
          <img
            src={captureUrlForPath(evidence.path)}
            alt={`Screen before ${step}`}
            className="absolute inset-0 h-full w-full object-contain"
          />
          {selected && marker ? (
            <span
              data-testid="task-click-marker"
              className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-green-500 shadow-[0_0_4px_2px_rgba(52,211,153,0.9),0_0_14px_5px_rgba(52,211,153,0.45)]"
              style={{
                left: `${Math.min(100, Math.max(0, marker.x))}%`,
                top: `${Math.min(100, Math.max(0, marker.y))}%`
              }}
              aria-label="Click location"
            />
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

export function TaskExecutionPlanView({
  task,
  guidanceMessages = [],
  showScreenshots = true,
  showDecisionDetails = true
}: {
  task: TaskTab
  guidanceMessages?: readonly string[]
  showScreenshots?: boolean
  showDecisionDetails?: boolean
}): React.JSX.Element | null {
  const [selectedStep, setSelectedStep] = useState<string | null>(null)
  const trace = phaseTrace(task)
  if (!trace) return null
  let guidanceIndex = 0
  const evidence: StepEvidence[] = (task.stepDetails ?? []).flatMap((detail) => {
    const path = detail.screenshot?.path
    if (!path) return []
    const actionCoordinateSpace =
      detail.actionCoordinateSpace ??
      (detail.execution?.result === 'actuated' ? 'viewport' : 'inference')
    return [
      {
        path,
        descriptions: mappedActionDescriptions(detail.mappedAction),
        ...(detail.decisionSummary ? { decisionSummary: detail.decisionSummary } : {}),
        ...(detail.decisionRationale ? { decisionRationale: detail.decisionRationale } : {}),
        ...(detail.modelOutput ? { modelOutput: detail.modelOutput } : {}),
        ...(detail.mappedAction ? { mappedAction: detail.mappedAction } : {}),
        ...(detail.execution?.result ? { executionResult: detail.execution.result } : {}),
        ...(detail.execution?.error ? { executionError: detail.execution.error } : {}),
        ...(detail.execution?.durationMs !== undefined
          ? { durationMs: detail.execution.durationMs }
          : {}),
        ...(detail.execution?.error
          ? { rejection: `rejected action: ${detail.execution.error}` }
          : {}),
        ...(mappedActionPoint(detail.mappedAction)
          ? { point: mappedActionPoint(detail.mappedAction) }
          : {}),
        frame: {
          width: detail.screenshot?.originalWidth ?? 1,
          height: detail.screenshot?.originalHeight ?? 1,
          coordinateWidth:
            actionCoordinateSpace === 'viewport'
              ? (detail.screenshot?.viewportWidth ?? detail.screenshot?.inferenceWidth ?? 1)
              : (detail.screenshot?.inferenceWidth ?? 1),
          coordinateHeight:
            actionCoordinateSpace === 'viewport'
              ? (detail.screenshot?.viewportHeight ?? detail.screenshot?.inferenceHeight ?? 1)
              : (detail.screenshot?.inferenceHeight ?? 1)
        },
        used: false
      }
    ]
  })
  const screenshotForStep = (step: string): StepEvidence | undefined => {
    const exact = evidence.find(
      (candidate) =>
        !candidate.used && (candidate.descriptions.includes(step) || candidate.rejection === step)
    )
    const kind = traceActionKind(step)
    const matched =
      exact ??
      (kind
        ? evidence.find(
            (candidate) =>
              !candidate.used &&
              (kind === 'rejected'
                ? Boolean(candidate.rejection)
                : kind === 'milestone'
                  ? candidate.executionResult === 'terminal' && candidate.descriptions.length === 0
                  : candidate.descriptions.some(
                      (description) => traceActionKind(description) === kind
                    ))
          )
        : undefined)
    if (!matched) return undefined
    matched.used = true
    return matched
  }
  return (
    <section aria-label="Task execution plan" className="border border-border">
      <div className="border-b border-border bg-muted/40 px-3 py-2">
        <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Execution plan</p>
        <p className="mt-0.5 text-[10px] text-foreground">
          {
            trace.phases.filter((_, index) => phaseState(task, index, trace.active) === 'complete')
              .length
          }
          {' of '}
          {trace.phases.length} stages complete
        </p>
      </div>
      <ol>
        {trace.phases.map((phase, index) => {
          const state = phaseState(task, index, trace.active)
          const Icon =
            state === 'complete' ? CheckCircle : state === 'failed' ? WarningCircle : Circle
          const open = state === 'active' || state === 'failed'
          return (
            <li key={phase.id} className="border-b border-border last:border-b-0">
              <details open={open}>
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[10px] text-foreground hover:bg-muted/50">
                  <Icon
                    size={14}
                    weight={state === 'upcoming' ? 'regular' : 'fill'}
                    className={
                      state === 'failed'
                        ? 'text-red-500'
                        : state === 'upcoming'
                          ? 'text-muted-foreground'
                          : 'text-green-500'
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{phase.title}</span>
                  <span className="text-[8px] uppercase tracking-wide text-muted-foreground">
                    {state}
                  </span>
                </summary>
                <ol className="px-3 pb-2 pl-9">
                  {phase.steps.length ? (
                    <>
                      {phase.steps.map((step, stepIndex) => {
                        const guidanceMessage =
                          step.startsWith('GUIDANCE ACCEPTED · ') ||
                          step.startsWith('USER GUIDANCE · ')
                            ? guidanceMessages[guidanceIndex++]
                            : undefined
                        const stepEvidence = screenshotForStep(step)
                        const visibleEvidence = stepEvidence
                          ? showScreenshots
                            ? stepEvidence
                            : { ...stepEvidence, path: '' }
                          : undefined
                        const selectionKey = `${phase.id}-${stepIndex}`
                        return (
                          <StepLine
                            key={`${phase.id}-${stepIndex}-${step}`}
                            step={step}
                            index={stepIndex}
                            guidanceMessage={guidanceMessage}
                            evidence={visibleEvidence}
                            showDecisionDetails={showDecisionDetails}
                            selected={selectedStep === selectionKey}
                            onSelect={() => setSelectedStep(selectionKey)}
                          />
                        )
                      })}
                    </>
                  ) : (
                    <>
                      <li className="py-2 text-[9px] text-muted-foreground">
                        {state === 'upcoming' ? 'Waiting for this stage.' : 'Preparing this stage.'}
                      </li>
                    </>
                  )}
                </ol>
              </details>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
