import { vi } from 'vitest'
import type { VideoGenerationResultContract } from '../../../../../shared/video-generation-contract'

export function createVideoBoundary() {
  return {
    videoGenStatus: vi.fn(async () => ({ available: false, models: [], active: null })),
    videoGenJobStatus: vi.fn(async () => ({
      id: null, phase: 'idle' as const, conversationId: null, projectId: null,
      stage: null, enhancedPrompt: '', progress: null, outputPath: null,
      error: null, startedAt: null, finishedAt: null
    })),
    onVideoGenJobState: vi.fn(() => () => {}),
    onVideoGenConversationUpdated: vi.fn(() => () => {}),
    generateVideo: vi.fn(async (): Promise<VideoGenerationResultContract> => {
      throw new Error('No video result configured')
    }),
    cancelVideoGen: vi.fn(async () => true),
    videoGenConversationPersisted: vi.fn(async () => true),
    listGeneratedVideos: vi.fn(async () => []),
    getMediaUrl: vi.fn(async () => 'http://127.0.0.1:9876/video.mp4')
  }
}
