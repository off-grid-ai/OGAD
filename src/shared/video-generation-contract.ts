export interface VideoGenerationRequestContract {
  prompt: string
  model?: string
  width?: number
  height?: number
  frames?: number
  fps?: number
  steps?: number
  guidance?: number
  seed?: number
  negativePrompt?: string
  enhancePrompt?: boolean
}

export interface VideoGenerationOutputContract {
  path: string
  prompt: string
  negativePrompt: string
  model: string
  width: number
  height: number
  frames: number
  fps: number
  steps: number
  guidance: number
  seed: number
  durationSeconds: number
}

export interface VideoGenerationResultContract extends VideoGenerationOutputContract {
  syncId: string
  durationMs: number
}

export type VideoGenerationStage = 'enhancing' | 'preparing' | 'generating' | 'encoding'
export type VideoGenerationPhase = 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface VideoGenerationProgressContract {
  step: number
  total: number
}

export interface VideoGenerationUpdateContract {
  stage: VideoGenerationStage
  enhancedPrompt?: string
  progress?: VideoGenerationProgressContract | null
}

export interface VideoGenerationJobContract {
  id: string | null
  phase: VideoGenerationPhase
  conversationId: string | null
  projectId: string | null
  stage: VideoGenerationStage | null
  enhancedPrompt: string
  progress: VideoGenerationProgressContract | null
  outputPath: string | null
  error: string | null
  startedAt: number | null
  finishedAt: number | null
}
