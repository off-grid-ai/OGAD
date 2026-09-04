/** Desktop composition root. Shared owns application behavior; Desktop supplies device I/O. */
import { randomUUID } from 'node:crypto'
import { createOffGridApplication, type OffGridApplication } from '@offgrid/application'
import { DEFAULT_RAG_EMBEDDING_DIMENSION } from '@offgrid/rag'
import { desktopModelWorkspace } from '../model-services'
import { resolveDesktopActivation } from '../models-manager'
import { embeddings } from '../embeddings'
import { desktopExtraction } from '../rag/extractors'
import { desktopVectorStore, projectExists } from '../rag/store'
import { applicationShutdown } from '../shutdown'
import { registerDesktopApplication } from './application-access'
import { desktopSyncStatePort } from '../sync-state-port'
import { createDesktopAutomationPorts, forwardDesktopAutomationEvent } from '../tasks/task-history'
import { createDesktopUsePorts, observeActionOutcome } from '../actions/use-runtime'
import { createDesktopGuidedSetupPorts } from './guided-setup'
import { createDesktopSpeechIoPorts } from './speech-io'
import { createDesktopSpeechSelectionPort } from './speech-selection'
import { setupSpeechMicrophoneIpc } from '../speech-microphone-ipc'
import { setupSpeechPlaybackIpc } from '../speech-playback-ipc'
import { setupSpeechTextCleaningIpc } from '../speech-text-cleaning-ipc'
import { consumeDesktopApplicationExtensionPorts } from './application-extension-ports'
import { claimDesktopSyncRuntime } from '../sync-runtime-owner'
import { writeDiagnosticLog } from '../diagnostics-log'
import { desktopApplicationHealth } from './application-health'

const speechIo = createDesktopSpeechIoPorts()
const extensionPorts = consumeDesktopApplicationExtensionPorts()

export const desktopApplication = createOffGridApplication({
  models: {
    workspace: desktopModelWorkspace,
    guidedSetup: createDesktopGuidedSetupPorts(),
    activation: { resolve: resolveDesktopActivation }
  },
  rag: {
    store: desktopVectorStore,
    embeddings: {
      dimension: DEFAULT_RAG_EMBEDDING_DIMENSION,
      embed: (text) => embeddings.generateEmbedding(text)
    },
    extraction: desktopExtraction,
    projectExists: async (projectId) => projectExists(projectId)
  },
  automation: createDesktopAutomationPorts(),
  use: createDesktopUsePorts(),
  sync: extensionPorts.sync,
  speech: {
    ...speechIo,
    microphone: setupSpeechMicrophoneIpc(),
    playback: setupSpeechPlaybackIpc(),
    selection: createDesktopSpeechSelectionPort(),
    cleanForSpeech: setupSpeechTextCleaningIpc().clean
  },
  pro: {
    ...extensionPorts.pro,
    sync: { ...extensionPorts.pro?.sync, state: desktopSyncStatePort }
  },
  newId: randomUUID
})

registerDesktopApplication(desktopApplication)
desktopApplication.automation.events(forwardDesktopAutomationEvent)
desktopApplication.use.events((event) => {
  if (event.type === 'action_outcome') observeActionOutcome(event.outcome)
})

let starting: ReturnType<typeof desktopApplication.start> | null = null
let releaseSyncRuntime: (() => void) | null = null
let releaseFailureObserver: (() => void) | null = null
let releaseHealthObserver: (() => void) | null = null

function describeFailure(failure: unknown): string {
  try {
    return JSON.stringify(failure)
  } catch {
    return String(failure)
  }
}

function observeApplicationFailures(): void {
  releaseFailureObserver ??= desktopApplication.events(({ domain, event }) => {
    if ((domain !== 'rag' && domain !== 'sync') || event.type !== 'operation_failed') return
    writeDiagnosticLog(
      'application',
      'domain.operation_failed',
      {
        domain,
        operation: event.operation,
        failure: describeFailure(event.failure)
      },
      'error'
    )
  })
}

function reportDegradedStart(
  result: Awaited<ReturnType<OffGridApplication['start']>>
): Awaited<ReturnType<OffGridApplication['start']>> {
  for (const { domain, reason } of result.degraded) {
    desktopApplicationHealth.reportDegraded({ domain, source: 'application', reason })
  }
  return result
}

/**
 * One projection of startup health for every consumer: shared's own status and retained
 * lifecycle failure, plus what each extension reports about its own activation. Every recorded
 * degradation is also written to the support log through the injected sink, so the log stays a
 * consequence of the observable state rather than the only place the truth lives.
 */
function observeApplicationHealth(): void {
  desktopApplicationHealth.setSink(({ domain, source, reason }) => {
    writeDiagnosticLog(
      'application',
      'lifecycle.start.degraded',
      { domain, source, reason },
      'error'
    )
  })
  releaseHealthObserver ??= desktopApplication.subscribe(({ status, lifecycleFailure }) => {
    desktopApplicationHealth.observeLifecycle({ status, lifecycleFailure })
  })
}

observeApplicationFailures()
observeApplicationHealth()

export function startDesktopApplication(): ReturnType<typeof desktopApplication.start> {
  if (starting) return starting

  const startPromise = (async () => {
    observeApplicationFailures()
    observeApplicationHealth()
    releaseSyncRuntime = claimDesktopSyncRuntime('application')
    try {
      return reportDegradedStart(await desktopApplication.start())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeDiagnosticLog('application', 'lifecycle.start.failed', { error: message }, 'error')
      // start() itself threw, so shared never published a lifecycle failure of its own. Publish it
      // here or the only record of a dead application would be this log line.
      desktopApplicationHealth.observeLifecycle({
        status: 'stopped',
        lifecycleFailure: { phase: 'start', message, causes: [message] }
      })
      releaseSyncRuntime()
      releaseSyncRuntime = null
      starting = null
      throw error
    }
  })()
  starting = startPromise
  return startPromise
}

export async function stopDesktopApplication(): Promise<void> {
  try {
    await desktopApplication.stop()
  } finally {
    releaseFailureObserver?.()
    releaseFailureObserver = null
    releaseHealthObserver?.()
    releaseHealthObserver = null
    desktopApplicationHealth.setSink(null)
    releaseSyncRuntime?.()
    releaseSyncRuntime = null
    starting = null
  }
}

applicationShutdown.register({ name: 'core:application', shutdown: stopDesktopApplication })
