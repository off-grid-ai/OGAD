import type { TaskExecutionPlan } from '../../shared/task-execution-plan'
import type { VisionGuard } from '../vision/vision-guard'
import type { BrowserDriver } from './browser-driver'
import type { SemanticPageSession } from './playwright-mcp-session'

export interface BrowserPlaywrightTaskResult {
  ok: boolean
  fallback: boolean
  summary: string
  handoffs: number
}

export interface BrowserSemanticObservation {
  step: number
  phase: 'observing' | 'checking' | 'waiting' | 'complete'
  summary: string
}

export interface BrowserPlaywrightTaskInput {
  goal: string
  plan: TaskExecutionPlan
  session: SemanticPageSession
  guard: VisionGuard
  /** The page's pointer overlay, where the session has one. Null: no pointer to show. */
  activeDriver: () => BrowserDriver | null
  activeUrl: () => string
  waitForUser: (why: string, signal?: AbortSignal) => Promise<void>
  takeGuidance: () => readonly string[]
  onStep: (note: string) => void
  onPhase: (phaseId: string) => void
  onProgress: (step: number, phase: 'observing' | 'thinking' | 'acting', action: string) => void
  onObservation?: (observation: BrowserSemanticObservation) => Promise<void>
  signal?: AbortSignal
}
