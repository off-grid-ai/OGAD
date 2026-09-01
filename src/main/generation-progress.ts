import type { DownloadProgress } from '@offgrid/executorch-speech'
import type { ImageGenerationPipelineUpdateContract } from '../shared/image-generation-contract'

const imageProgressObservers = new Map<
  string,
  (update: ImageGenerationPipelineUpdateContract) => void
>()
const voiceProgressObservers = new Map<string, (progress: DownloadProgress) => void>()

export function registerDesktopImageProgress(
  turnId: string,
  observer: (update: ImageGenerationPipelineUpdateContract) => void
): () => void {
  imageProgressObservers.set(turnId, observer)
  return () => {
    if (imageProgressObservers.get(turnId) === observer) imageProgressObservers.delete(turnId)
  }
}

export function registerDesktopVoiceProgress(
  turnId: string,
  observer: (progress: DownloadProgress) => void
): () => void {
  voiceProgressObservers.set(turnId, observer)
  return () => {
    if (voiceProgressObservers.get(turnId) === observer) voiceProgressObservers.delete(turnId)
  }
}

export function reportDesktopImageProgress(
  turnId: string,
  update: ImageGenerationPipelineUpdateContract
): void {
  imageProgressObservers.get(turnId)?.(update)
}

export function reportDesktopVoiceProgress(turnId: string, progress: DownloadProgress): void {
  voiceProgressObservers.get(turnId)?.(progress)
}
