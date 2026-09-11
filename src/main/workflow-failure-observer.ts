/**
 * The only place a standing bridge's failure surfaces.
 *
 * `workflows.events` is a separate stream from the application root's domain events, and nothing
 * was reading it. Three bridges run for the whole application lifetime - knowledge-document
 * replication, task-run replication, and cancelling a generation when the person speaks over it -
 * and by construction they have NO caller to return a failure to. So an unobserved
 * `workflows.events` means those three fail silently forever, which is the one case the workflow
 * contract calls out explicitly.
 *
 * The two event kinds are deliberately treated differently:
 *
 * - `bridge_failed` is a standing capability that stopped working with nobody to tell, so it is
 *   recorded AND published on the degraded projection: a surface can then say why replication or
 *   barge-in is not happening.
 * - `workflow_failed` already has a caller who was told - a failed voice question is rendered in
 *   the composer - so it is recorded and NOT marked degraded. Marking the domain degraded for one
 *   refused request would leave "speech is degraded" standing after a single mistyped question.
 */
import {
  workflowFailureMessage,
  type OffGridDomain,
  type WorkflowEvent
} from '@offgrid/application'
import { reportDesktopApplicationDegraded } from './composition/application-access'
import { writeDiagnosticLog } from './diagnostics-log'

export const WORKFLOW_DEGRADATION_SOURCE = 'workflow-bridge'

/** The domain a workflow failure belongs to, when it names one. */
function failingDomain(event: WorkflowEvent): OffGridDomain | null {
  const { kind } = event.failure
  if (kind === 'speech' || kind === 'models' || kind === 'rag' || kind === 'sync') return kind
  return null
}

export interface WorkflowFailureSource {
  workflows: { events(listener: (event: WorkflowEvent) => void): () => void }
}

/** Subscribe for the application's lifetime. Returns the release, for the shutdown registry. */
export function observeWorkflowFailures(application: WorkflowFailureSource): () => void {
  return application.workflows.events((event) => {
    const reason = workflowFailureMessage(event.failure)
    if (event.type === 'bridge_failed') {
      writeDiagnosticLog('workflows', 'bridge.failed', { bridge: event.bridge, reason }, 'error')
      const domain = failingDomain(event)
      if (domain) {
        reportDesktopApplicationDegraded({
          domain,
          source: WORKFLOW_DEGRADATION_SOURCE,
          reason: `${event.bridge}: ${reason}`
        })
      }
      return
    }
    writeDiagnosticLog(
      'workflows',
      'workflow.failed',
      { workflow: event.workflow, operationId: event.operationId ?? undefined, reason },
      'error'
    )
  })
}
