export type ComputerUseAdmissionFailure =
  | 'accessibility_unavailable'
  | 'capture_permission_missing'
  | 'display_unavailable'
  | 'target_window_missing'
  | 'input_actuation_unavailable'
  | 'decision_model_missing'
  | 'decision_runtime_failed'
  | 'specialist_missing'
  | 'remote_capability_missing'
  | 'model_out_of_memory'

export interface ComputerUsePreflightInput {
  accessibilityAvailable: boolean
  capturePermission: boolean
  displayAvailable: boolean
  targetWindowAvailable: boolean
  inputActuationAvailable: boolean
  decisionModelAvailable: boolean
  decisionRuntimeAvailable: boolean
  specialistRequired: boolean
  specialistAvailable: boolean
  remoteCapabilityRequired: boolean
  remoteCapabilityAvailable: boolean
  modelOutOfMemory?: boolean
}

export type ComputerUsePreflightResult =
  | { ok: true }
  | { ok: false; failure: ComputerUseAdmissionFailure; countsAsPolicyFailure: false }

/** Admission runs before policy evaluation. The order is intentional: missing hardware,
 * permissions, targets, and tools must never be reported as model accuracy failures. */
export function computerUsePreflight(input: ComputerUsePreflightInput): ComputerUsePreflightResult {
  const failure: ComputerUseAdmissionFailure | undefined = !input.accessibilityAvailable
    ? 'accessibility_unavailable'
    : !input.displayAvailable
      ? 'display_unavailable'
      : !input.capturePermission
        ? 'capture_permission_missing'
        : !input.targetWindowAvailable
          ? 'target_window_missing'
          : !input.inputActuationAvailable
            ? 'input_actuation_unavailable'
            : !input.decisionModelAvailable
              ? 'decision_model_missing'
              : input.modelOutOfMemory
                ? 'model_out_of_memory'
                : !input.decisionRuntimeAvailable
                  ? 'decision_runtime_failed'
                  : input.specialistRequired && !input.specialistAvailable
                    ? 'specialist_missing'
                    : input.remoteCapabilityRequired && !input.remoteCapabilityAvailable
                      ? 'remote_capability_missing'
                      : undefined
  return failure ? { ok: false, failure, countsAsPolicyFailure: false } : { ok: true }
}

export function classifyCaptureFailure(
  message: string
): Extract<ComputerUseAdmissionFailure, 'capture_permission_missing' | 'display_unavailable'> {
  return /no display|display unavailable|no screen|display was not found/i.test(message)
    ? 'display_unavailable'
    : 'capture_permission_missing'
}
