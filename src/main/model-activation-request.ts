import { activateModel } from './models-manager'
import { llm } from './llm'
import { parseRemoteVisionModelId } from '../shared/remote-vision-server'
import { writeDiagnosticLog } from './diagnostics-log'

/** Activation and runtime startup shared by the HTTP gateway and sealed bridge. */
export async function activateModelFromRequest(
  modelId: string,
  kind?: string
): Promise<{ success: boolean; error?: string }> {
  const result = await activateModel(modelId, kind)
  if (result.success && !parseRemoteVisionModelId(modelId)) {
    void llm.init().catch((error) => {
      writeDiagnosticLog(
        'gateway',
        'model_activation.start_failed',
        { model: modelId, error: error instanceof Error ? error.message : String(error) },
        'error'
      )
    })
  }
  return result
}
