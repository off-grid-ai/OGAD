// Composition root: the shared downloaded-model registry over Desktop's JSON + fs ports.
import { DownloadedModelRegistryService } from '@offgrid/models'
import { desktopDownloadedRegistryPorts } from '../downloaded-models'

export function downloadedModelRegistry(dir: string): DownloadedModelRegistryService {
  return new DownloadedModelRegistryService(desktopDownloadedRegistryPorts(dir))
}
