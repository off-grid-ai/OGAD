export type ComputerUsePhase =
  | 'preparing'
  | 'observing'
  | 'thinking'
  | 'acting'
  | 'checking'
  | 'waiting'
  | 'paused'
  | 'complete'
  | 'failed'
  | 'stopped'

export interface ComputerUseStepDetail {
  stepId: string
  at: number
  phase?: ComputerUsePhase
  modelInput?: string
  screenshot?: {
    /** This path is valid only on the execution device. */
    path?: string
    availability?: 'device_local' | 'unavailable'
    executionDeviceId?: string
    executionDeviceName?: string
    originalWidth: number
    originalHeight: number
    inferenceWidth: number
    inferenceHeight: number
    /** Browser input coordinate space for this frame. */
    viewportWidth?: number
    viewportHeight?: number
  }
  retrievedFacts?: string[]
  tokenUsage?: { input?: number; output?: number; context?: number }
  decisionSummary?: string
  reasoning?: string
  decisionRationale?: string
  modelOutput?: string
  /** Legacy input accepted during migration. Sanitization stores it as modelOutput. */
  rawResponse?: string
  mappedAction?: string
  /** Coordinate space used by points in mappedAction. */
  actionCoordinateSpace?: 'inference' | 'viewport'
  execution?: {
    status: 'complete' | 'failed'
    durationMs?: number
    result?: string
    error?: string
  }
}
