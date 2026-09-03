// Renderer composition root: shared capture readiness over Electron observations and I/O.
import { CaptureReadinessApplicationService } from '@offgrid/models'
import { desktopCaptureReadinessPorts } from '@renderer/components/use-capture-readiness'

let instance: CaptureReadinessApplicationService | undefined
export function captureReadinessApplication(): CaptureReadinessApplicationService {
  instance ??= new CaptureReadinessApplicationService(desktopCaptureReadinessPorts())
  return instance
}
