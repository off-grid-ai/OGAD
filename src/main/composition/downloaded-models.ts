// Composition root: the shared downloaded-model registry over Desktop's JSON + fs ports.
import { DownloadedModelRegistryService } from '@offgrid/models'

type DownloadedRegistryPorts = ConstructorParameters<typeof DownloadedModelRegistryService>[0]

let desktopPorts: ((dir: string) => DownloadedRegistryPorts) | null = null

export function registerDesktopDownloadedRegistryPorts(
  ports: (dir: string) => DownloadedRegistryPorts
): void {
  if (desktopPorts)
    throw new Error('Desktop downloaded-model registry ports are already registered.')
  desktopPorts = ports
}

export function downloadedModelRegistry(dir: string): DownloadedModelRegistryService {
  if (!desktopPorts) throw new Error('Desktop downloaded-model registry ports are not registered.')
  return new DownloadedModelRegistryService(desktopPorts(dir))
}
