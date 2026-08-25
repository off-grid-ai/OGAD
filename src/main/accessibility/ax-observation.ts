import { appendComputerUseStepDetail } from '../tasks/task-history'
import type { ElementStepObservation } from './ax-agent'

/** Persist AX planning evidence through the same bounded, redacted task-history
 * adapter as vision Computer Use. AX is text-grounded, so it has no screenshot. */
export function persistAxObservation(
  taskId: string,
  title: string,
  observation: ElementStepObservation
): void {
  appendComputerUseStepDetail(taskId, title, {
    stepId: String(observation.step),
    at: Date.now(),
    modelInput: observation.prompt,
    retrievedFacts: observation.retrievedFacts,
    rawResponse: observation.rawResponse,
    mappedAction:
      observation.parsedAction === undefined ? undefined : JSON.stringify(observation.parsedAction),
    execution: {
      status: observation.result === 'error' ? 'failed' : 'complete',
      durationMs: observation.durationMs,
      result: observation.result,
      error: observation.error
    }
  })
}
