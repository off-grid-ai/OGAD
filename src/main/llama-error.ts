// The text-engine failure taxonomy is owned by @offgrid/models (text-engine-failure-policy). This
// file only binds the host platform. Import from '@offgrid/models' in new code.
import {
  classifyTextEngineFailure,
  modelPortConflictReason,
  type TextEngineFailure
} from '@offgrid/models'

export type LlamaFailure = TextEngineFailure
export { modelPortConflictReason }

export function classifyLlamaError(
  stderr: string,
  platform: string = process.platform
): LlamaFailure | null {
  return classifyTextEngineFailure(stderr, platform)
}
