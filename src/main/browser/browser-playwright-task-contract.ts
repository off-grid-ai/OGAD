import type { TaskExecutionPlan } from '../../shared/task-execution-plan'
import type { VisionGuard } from '../vision/vision-guard'
import type { BrowserDriver } from './browser-driver'
import type { PlaywrightMcpSession } from './playwright-mcp-session'
import type {
  BrowserSemanticDecisionRequest,
  SemanticDecision
} from './browser-playwright-policy'

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
  session: PlaywrightMcpSession
  guard: VisionGuard
  activeDriver: () => BrowserDriver
  activeUrl: () => string
  waitForUser: (why: string, signal?: AbortSignal) => Promise<void>
  takeGuidance: () => readonly string[]
  onStep: (note: string) => void
  onPhase: (phaseId: string) => void
  onProgress: (step: number, phase: 'observing' | 'thinking' | 'acting', action: string) => void
  onObservation?: (observation: BrowserSemanticObservation) => Promise<void>
  decide?: (request: BrowserSemanticDecisionRequest) => Promise<SemanticDecision>
  signal?: AbortSignal
}
