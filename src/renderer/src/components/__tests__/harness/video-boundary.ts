import { vi } from 'vitest'

/** The free video library at the preload boundary. Generation is Pro and absent here. */
export function createVideoBoundary(): Record<string, unknown> {
  return {
    videoGenStatus: vi.fn(async () => ({ available: false, models: [], active: null })),
    listGeneratedVideos: vi.fn(async () => []),
    getMediaUrl: vi.fn(async () => 'http://127.0.0.1:9876/video.mp4')
  }
}
