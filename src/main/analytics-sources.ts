import { registerFeatureSnapshotSource, registerUsageCountSource } from './analytics'
import { modelCountKey } from './analytics/usage-snapshot'
import { listGeneratedVideos } from './generated-videos/library'
import { listGeneratedImages } from './imagegen'
import { llm } from './llm'
import { getActiveModalities, getStorageInfo } from './models-manager'
import {
  getActiveRemoteVisionServer,
  getRemoteVisionServerSettings
} from './vision/remote-vision-server'

/** One reading, or nothing when it fails: a failing reader leaves its own value out. */
function read<T>(reader: () => T): T | undefined {
  try {
    return reader()
  } catch {
    return undefined
  }
}

/**
 * Core's model, media and remote-server readings for the daily snapshots. They are registered at
 * startup rather than imported by analytics: models-manager, llm and imagegen report to analytics,
 * so analytics importing them made import cycles (dependency-cruiser no-circular).
 */
export function registerCoreAnalyticsSources(): void {
  registerFeatureSnapshotSource(() => {
    const active = read(getActiveModalities)
    return {
      remote_server: Boolean(read(getActiveRemoteVisionServer)),
      image_generation: Boolean(active?.image),
      tts: Boolean(active?.speech),
      voice_input: Boolean(active?.transcription),
      vision: read(() => llm.hasVision()) === true
    }
  })
  registerUsageCountSource(async () => {
    const counts: Record<string, number> = {}
    const images = read(() => listGeneratedImages().length)
    if (images !== undefined) counts.generated_images = images
    const videos = read(() => listGeneratedVideos().length)
    if (videos !== undefined) counts.generated_videos = videos
    const servers = read(() => getRemoteVisionServerSettings().servers.length)
    if (servers !== undefined) counts.remote_servers = servers
    try {
      for (const model of (await getStorageInfo()).models) {
        const key = modelCountKey(model.kind)
        if (key) counts[key] = (counts[key] ?? 0) + 1
      }
    } catch {
      /* left out */
    }
    return counts
  })
}
