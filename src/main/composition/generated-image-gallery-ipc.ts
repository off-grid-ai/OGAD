import { BrowserWindow } from 'electron'
import type { GeneratedImageGalleryFacade } from '@offgrid/application'

const CHANNEL = 'imagegen:gallery-changed'

/** Publish committed gallery projection changes without giving the renderer a second state owner. */
export function registerGeneratedImageGalleryProjectionIpc(
  gallery: GeneratedImageGalleryFacade
): () => void {
  return gallery.subscribe(() => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(CHANNEL)
    }
  })
}
