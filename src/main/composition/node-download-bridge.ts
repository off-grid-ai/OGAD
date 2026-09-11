// Composition root: the shared Node download bridge over one destination directory.
import { NodeDownloadBridge } from '@offgrid/models/node'

export function nodeDownloadBridge(dir: string): NodeDownloadBridge {
  return new NodeDownloadBridge(dir)
}
