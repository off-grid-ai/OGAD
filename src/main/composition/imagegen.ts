// Composition root: the shared image generation application over Desktop's image ports.
import { ImageGenerationApplicationService } from '@offgrid/models'
import type { ImageGenerationOutputContract } from '../../shared/image-generation-contract'
import {
  desktopImageApplicationPorts,
  type DesktopImageSharedRequest
} from '../imagegen/application-service'
import { desktopModelServices } from '../model-service-access'
import { once } from '@offgrid/models'

export const imageGenerationApplication = once(
  () =>
    new ImageGenerationApplicationService<
      ImageGenerationOutputContract,
      ImageGenerationOutputContract,
      DesktopImageSharedRequest
    >(
      { resolveRoute: (requirements) => desktopModelServices.llm.resolveRoute(requirements) },
      desktopImageApplicationPorts()
    )
)
