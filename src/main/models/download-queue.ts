import {
  DOWNLOAD_INTERRUPTED_ERROR,
  ModelDownloadQueue,
  type DownloadQueueState,
  type DownloadResult
} from '@offgrid/models'

export {
  DOWNLOAD_INTERRUPTED_ERROR,
  ModelDownloadQueue,
  type DownloadQueueState,
  type DownloadResult
}

/** Desktop owns only the process lifetime. Shared owns queue admission and cancellation policy. */
export const modelDownloadQueue = new ModelDownloadQueue()

export function shutdownModelDownloads(): Promise<void> {
  return modelDownloadQueue.shutdown()
}
