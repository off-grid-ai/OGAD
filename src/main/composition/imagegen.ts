// Composition root: the shared image application over registered Desktop I/O ports.
import {
  ImageGenerationApplicationService,
  once,
  type ImageGenerationApplicationPorts
} from '@offgrid/models'
import type {
  ImageGenerationOutputContract,
  ImageGenerationRequestContract
} from '../../shared/image-generation-contract'
import { desktopModels } from './application-access'

type DesktopImageSharedRequest = ImageGenerationRequestContract & {
  requestId?: string
  routeId?: string
  conversationId?: string
  projectId?: string | null
  messageId?: string
  guidanceScale?: number
  sourceImageUri?: string
}

type DesktopImageApplicationPorts = ImageGenerationApplicationPorts<
  ImageGenerationOutputContract,
  ImageGenerationOutputContract,
  DesktopImageSharedRequest
>

let desktopPorts: DesktopImageApplicationPorts | null = null

export function registerDesktopImageApplicationPorts(ports: DesktopImageApplicationPorts): void {
  if (desktopPorts) throw new Error('Desktop image application ports are already registered.')
  desktopPorts = ports
}

export const imageGenerationApplication = once(() => {
  if (!desktopPorts) throw new Error('Desktop image application ports are not registered.')
  return new ImageGenerationApplicationService<
    ImageGenerationOutputContract,
    ImageGenerationOutputContract,
    DesktopImageSharedRequest
  >({ resolveRoute: (requirements) => desktopModels.resolve(requirements) }, desktopPorts)
})
