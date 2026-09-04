/** Desktop composition root. Shared owns application behavior; Desktop supplies device I/O. */
import { randomUUID } from 'node:crypto'
import {
  createOffGridApplication,
  type ApplicationDegradation,
  type ApplicationLifecycleEvent,
  type OffGridApplicationSnapshot
} from '@offgrid/application'
import { DEFAULT_RAG_EMBEDDING_DIMENSION } from '@offgrid/rag'
import { desktopModelWorkspace } from '../model-services'
import { resolveDesktopActivation } from '../models-manager'
import { createDesktopModelSettingsPort } from '../models/model-settings-port'
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

const speechIo = createDesktopSpeechIoPorts()
const extensionPorts = consumeDesktopApplicationExtensionPorts()

export const desktopApplication = createOffGridApplication({
  models: {
    workspace: desktopModelWorkspace,
    guidedSetup: createDesktopGuidedSetupPorts(),
    activation: { resolve: resolveDesktopActivation },
    settings: createDesktopModelSettingsPort()
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

let starting: ReturnType<typeof desktopApplication.start> | null = null
let releaseSyncRuntime: (() => void) | null = null
let releaseFailureObserver: (() => void) | null = null
let releaseHealthObserver: (() => void) | null = null
let releaseAutomationForwarder: (() => void) | null = null
let releaseUseForwarder: (() => void) | null = null

/**
 * Two domain streams desktop forwards to owners of its own: Automation's events to the task-history
 * writer, and Use's action outcomes to the action-outcome observer.
 *
 * Owned the same way every other subscription here is - registered once, released by
 * `stopDesktopApplication` - because a subscription whose disposer is discarded cannot be released,
 * and then `stop()` cannot return the application's listener count to its pre-start value. That is a
 * lifecycle budget this program measures, so it is worth two variables.
 */
function observeDomainForwarding(): void {
  releaseAutomationForwarder ??= desktopApplication.automation.events(forwardDesktopAutomationEvent)
  releaseUseForwarder ??= desktopApplication.use.events((event) => {
    if (event.type === 'action_outcome') observeActionOutcome(event.outcome)
  })
}

function describeFailure(failure: unknown): string {
  try {
    return JSON.stringify(failure)
  } catch {
    return String(failure)
  }
}

/**
 * The root's own failures, on the same typed stream the domains use.
 *
 * `lifecycle_failed` carries the derived failure for the whole phase; `recovered` says which
 * reporter retracted, and that other reporters of the same domain may still be reporting - a domain
 * is healthy only once every one of them has. `degraded` is deliberately NOT logged here: the health
 * observer below already writes one line per reason and dedupes it, and it reads the snapshot on
 * attach so a late subscriber still records what was reported before it existed, which an event
 * stream cannot replay. Logging it in both places would make one fact two records.
 */
function observeLifecycleFailure(event: ApplicationLifecycleEvent): void {
  if (event.type === 'degraded') return
  if (event.type === 'recovered') {
    writeDiagnosticLog(
      'application',
      'lifecycle.recovered',
      {
        domain: event.domain,
        source: event.source,
        remainingFailure: event.lifecycleFailure?.message ?? null
      },
      'info'
    )
    return
  }
  writeDiagnosticLog(
    'application',
    'lifecycle.failed',
    {
      phase: event.failure.phase,
      failure: event.failure.message,
      causes: event.failure.causes.join(' | ')
    },
    'error'
  )
}

function observeApplicationFailures(): void {
  releaseFailureObserver ??= desktopApplication.events(({ domain, event }) => {
    if (domain === 'lifecycle') {
      observeLifecycleFailure(event)
      return
    }
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

const degradationKey = ({ domain, source, reason }: ApplicationDegradation): string =>
  `${source}:${domain}:${reason}`

/**
 * Startup health is shared's state, not a desktop store: `application.snapshot().degraded` retains
 * every owner's report - shared's own failed start steps and anything an extension reports beside
 * the root through `reportDegraded` - so a consumer that subscribes long after boot still sees it.
 *
 * The only desktop job left is the support log, and it stays a CONSEQUENCE of that state: write a
 * line the first time an owner reports a reason, never again for the same reason, and never for
 * unrelated domain traffic on the same snapshot.
 */
const loggedDegradations = new Set<string>()

function writeDegradations(snapshot: Pick<OffGridApplicationSnapshot, 'degraded'>): void {
  for (const entry of snapshot.degraded) {
    const key = degradationKey(entry)
    if (loggedDegradations.has(key)) continue
    loggedDegradations.add(key)
    writeDiagnosticLog('application', 'lifecycle.start.degraded', { ...entry }, 'error')
  }
}

function observeApplicationHealth(): void {
  if (releaseHealthObserver) return
  writeDegradations(desktopApplication.snapshot())
  releaseHealthObserver = desktopApplication.subscribe(writeDegradations)
}

observeApplicationFailures()
observeApplicationHealth()
observeDomainForwarding()

export function startDesktopApplication(): ReturnType<typeof desktopApplication.start> {
  if (starting) return starting

  const startPromise = (async () => {
    observeApplicationFailures()
    observeApplicationHealth()
    observeDomainForwarding()
    releaseSyncRuntime = claimDesktopSyncRuntime('application')
    // No catch: `start()` never rejects. Every step's failure, and anything thrown outside the step
    // loop, is recorded as a keyed report and reaches the observers above as a `'lifecycle'` event -
    // so a catch here could only write a second, competing record of state shared already owns.
    return await desktopApplication.start()
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
    releaseAutomationForwarder?.()
    releaseAutomationForwarder = null
    releaseUseForwarder?.()
    releaseUseForwarder = null
    releaseSyncRuntime?.()
    releaseSyncRuntime = null
    starting = null
  }
}

applicationShutdown.register({ name: 'core:application', shutdown: stopDesktopApplication })
