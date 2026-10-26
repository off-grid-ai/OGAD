import fs from 'node:fs'
import {
  isSupportedVideoWeight,
  isVideoWeightAvailableOn,
  videoPackFiles,
  type VideoModelPack
} from '@offgrid/models'
import { callHook, HOOKS } from '../bootstrap/hookRegistry'
import { resolveExistingOwnedEntry } from '../imagegen/owned-path'
import { modelsDir } from '../runtime-env'

export interface VideoGenerationStatus {
  available: boolean
  models: string[]
  active: string | null
  reason?: string
}

/** Complete video model packs on this computer. Model files stay core: Models manages them. */
export function installedVideoPacks(): Array<{ name: string; pack: VideoModelPack }> {
  const directory = modelsDir()
  try {
    return fs
      .readdirSync(directory)
      .filter(
        (name) => isSupportedVideoWeight(name) && isVideoWeightAvailableOn(name, process.platform)
      )
      .flatMap((name) => {
        const names = videoPackFiles(name)!
        const pack: Record<string, string> = {}
        for (const [role, file] of Object.entries(names)) {
          const owned = resolveExistingOwnedEntry(directory, file)
          if (!owned) return []
          pack[role] = owned
        }
        return [{ name, pack: pack as unknown as VideoModelPack }]
      })
  } catch {
    return []
  }
}

/** Video generation is a Pro feature. Without Pro, installed packs are listed but unavailable. */
export function videoGenerationStatus(options: { localOnly?: boolean } = {}): VideoGenerationStatus {
  return (
    callHook<VideoGenerationStatus>(HOOKS.videoStatus, options) ?? {
      available: false,
      models: installedVideoPacks().map((item) => item.name),
      active: null,
      reason: 'Video needs Off Grid AI Pro.'
    }
  )
}
