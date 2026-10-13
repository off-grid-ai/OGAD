// One process-wide admission gate, shared by IPC and headless downloads.
let moving = false
let downloads = 0
export const STORAGE_DOWNLOAD_ERROR =
  'Wait for model downloads to finish or cancel them, then try again.'

export function storageDownloadsActive(): boolean {
  return downloads > 0
}

export function beginStorageMove(): () => void {
  if (moving) throw new Error('A model folder move is already in progress.')
  moving = true
  return () => {
    moving = false
  }
}

export async function withStorageDownload<T>(work: () => Promise<T>): Promise<T> {
  if (moving)
    throw new Error('Model files are being moved. Try the download again after the move finishes.')
  downloads++
  try {
    return await work()
  } finally {
    downloads--
  }
}
