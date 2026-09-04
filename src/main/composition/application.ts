/** Desktop composition root. Shared owns application behavior; Desktop supplies device I/O. */
import { randomUUID } from 'node:crypto'
import {
  createOffGridApplication,
  type ApplicationDegradation,
  type ApplicationLifecycleEvent,
  type AutomationEvent,
  type ModelsEvent,
  type OffGridApplicationSnapshot,
  type RagEvent,
  type SpeechEvent,
  type SyncEvent,
  type UseEvent,
  type WorkflowEvent
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
import { writeDiagnosticLog, type DiagnosticValue } from '../diagnostics-log'
import { setupVoiceTurnIpc } from '../voice-turn-ipc'

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
  // The one cross-domain port: a voice question that belongs to a CONVERSATION. Main owns the
  // decision, the renderer owns the turn - it holds the persisted rows, the retrieval context, the
  // tool loop and the variants - so this broker asks the window to run its own turn and waits for
  // the answer, the same inversion the speech playback broker uses. Without it `askByVoice` can only
  // answer a conversation-less question.
  voiceTurn: setupVoiceTurnIpc(),
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

type Fields = Record<string, DiagnosticValue>

/**
 * Every event in a domain's stream that CARRIES a failure.
 *
 * Derived from the contract rather than listed, so this is the half of the exhaustiveness check that
 * matters: each handler ends by assigning its remaining events to `Exclude<E, FailureEvent<E>>`, so a
 * new FAILURE event stops compiling while an ordinary non-failure addition changes nothing. An
 * exhaustive switch over every member of a domain's union would do the opposite - break the app every
 * time shared adds a routine event - which is why this is keyed on the failure payload instead.
 *
 * Four failure events are NOT detectable this way, because they carry no `failure` field, and each is
 * handled explicitly below: sync `transfer_failed`, models `settings_launch_restart` and `download`
 * (one type multiplexing started/failed/finished), and speech `speech_finished`, where a failure is
 * an OUTCOME. Shared making failures uniformly detectable is WIRING_B #8, which desktop shares.
 */
type FailureEvent<E> = Extract<E, { readonly failure: unknown }>

/**
 * A repeating failure is recorded in full three times, then counted.
 *
 * Two paths amplify: `speech_finished` lands PER SENTENCE while a reply is still streaming, and a
 * sync `operation_failed` re-reports on every retry against an unreachable device. Both would
 * otherwise turn one condition into an unbounded run of identical lines in a bounded log, pushing
 * out the diagnostics around it.
 *
 * The key is the domain, the event and the failure SUMMARY - deliberately NOT the correlation
 * identity, because the amplifying cases carry a fresh `operationId` per attempt and keying on it
 * would defeat the cap entirely. Withheld repeats are attached to the next DISTINCT failure, so a
 * run never ends in a silent tail: the count is always eventually written.
 */
const FAILURE_BURST = 3
let lastFailureKey: string | null = null
let repeatsOfLastFailure = 0
let withheldRepeats = 0

function recordFailure(logEvent: string, summaryKey: string, fields: Fields): void {
  if (summaryKey === lastFailureKey) {
    repeatsOfLastFailure += 1
    if (repeatsOfLastFailure > FAILURE_BURST) {
      withheldRepeats += 1
      return
    }
  } else {
    lastFailureKey = summaryKey
    repeatsOfLastFailure = 1
  }
  const tail = withheldRepeats > 0 ? { withheldRepeats } : {}
  withheldRepeats = 0
  writeDiagnosticLog('application', logEvent, { ...fields, ...tail }, 'error')
}

/** Models has no `operation_failed`; it names each failure after the operation that produced it. */
function recordModelsFailure(event: ModelsEvent): void {
  switch (event.type) {
    case 'model_load_failed':
    case 'model_prepare_failed':
    case 'model_unload_failed':
      recordFailure(
        `models.${event.type}`,
        `models:${event.type}:${describeFailure(event.failure)}`,
        {
          operationId: event.operationId,
          modality: event.modality,
          failure: describeFailure(event.failure)
        }
      )
      return
    case 'model_eject_failed':
    case 'settings_save_failed':
    case 'generation_failed':
      recordFailure(
        `models.${event.type}`,
        `models:${event.type}:${describeFailure(event.failure)}`,
        {
          operationId: event.operationId,
          failure: describeFailure(event.failure)
        }
      )
      return
    // Multiplexed: one type covers started/completed/failed/superseded, so the failure is a status.
    case 'settings_launch_restart':
      if (event.status !== 'failed') return
      recordFailure(
        'models.settings_launch_restart_failed',
        `models:launch_restart:${event.message ?? ''}`,
        { operationId: event.operationId, failure: event.message ?? null }
      )
      return
    // Multiplexed: the download stream carries progress, completion and error under one type.
    case 'download': {
      const download = event.event
      if (download.status !== 'failed') return
      recordFailure('models.download_failed', `models:download:${download.reason ?? ''}`, {
        downloadId: download.downloadId,
        modelId: download.modelId,
        fileName: download.fileName,
        failure: download.reason ?? null
      })
      return
    }
    default: {
      const routine: Exclude<ModelsEvent, FailureEvent<ModelsEvent>> = event
      void routine
      return
    }
  }
}

/** Sync correlates by the entity a command was about, and reports a failed transfer separately. */
function recordSyncFailure(event: SyncEvent): void {
  switch (event.type) {
    case 'operation_failed':
      recordFailure(
        'sync.operation_failed',
        `sync:operation_failed:${event.operation}:${describeFailure(event.failure)}`,
        {
          operation: event.operation,
          entityId: event.entityId ?? null,
          failure: describeFailure(event.failure)
        }
      )
      return
    // No `failure` field: the reason is a string and the transfer snapshot is the identity.
    case 'transfer_failed':
      recordFailure('sync.transfer_failed', `sync:transfer_failed:${event.reason}`, {
        transfer: describeFailure(event.transfer),
        failure: event.reason
      })
      return
    default: {
      const routine: Exclude<SyncEvent, FailureEvent<SyncEvent>> = event
      void routine
      return
    }
  }
}

/** Speech names each failure, and reports a failed SPEAK as an outcome rather than a failure event. */
function recordSpeechFailure(event: SpeechEvent): void {
  switch (event.type) {
    case 'transcription_failed':
      recordFailure(
        'speech.transcription_failed',
        `speech:transcription_failed:${describeFailure(event.failure)}`,
        {
          operationId: event.operationId,
          failure: describeFailure(event.failure)
        }
      )
      return
    // Correlated by the MESSAGE it retries, which is what a reader needs to find the retry loop.
    case 'transcription_retry_failed':
      recordFailure(
        'speech.transcription_retry_failed',
        `speech:transcription_retry_failed:${describeFailure(event.failure)}`,
        {
          messageId: event.messageId,
          failure: describeFailure(event.failure)
        }
      )
      return
    case 'engine_release_failed':
      recordFailure(
        'speech.engine_release_failed',
        `speech:engine_release_failed:${describeFailure(event.failure)}`,
        {
          failure: describeFailure(event.failure)
        }
      )
      return
    // No `failure` field. A finished speak is only a failure for four of its seven outcomes -
    // `spoken`, `nothing-to-speak` and `busy` are ordinary - and this is the per-sentence amplifier.
    case 'speech_finished': {
      const kind = event.outcome.kind
      if (
        kind !== 'no-audio' &&
        kind !== 'engine-unavailable' &&
        kind !== 'synthesis-failed' &&
        kind !== 'engine-stuck'
      ) {
        return
      }
      recordFailure('speech.speech_failed', `speech:speech_finished:${kind}`, {
        operationId: event.operationId,
        failure: kind
      })
      return
    }
    default: {
      const routine: Exclude<SpeechEvent, FailureEvent<SpeechEvent>> = event
      void routine
      return
    }
  }
}

/** Automation correlates by task, Use by action, RAG by operation alone. */
function recordAutomationFailure(event: AutomationEvent): void {
  if (event.type !== 'operation_failed') {
    const routine: Exclude<AutomationEvent, FailureEvent<AutomationEvent>> = event
    void routine
    return
  }
  recordFailure(
    'automation.operation_failed',
    `automation:${event.operation}:${describeFailure(event.failure)}`,
    {
      operation: event.operation,
      taskId: event.taskId,
      failure: describeFailure(event.failure)
    }
  )
}

function recordUseFailure(event: UseEvent): void {
  if (event.type !== 'operation_failed') {
    const routine: Exclude<UseEvent, FailureEvent<UseEvent>> = event
    void routine
    return
  }
  recordFailure(
    'use.operation_failed',
    `use:${event.operation}:${describeFailure(event.failure)}`,
    {
      operation: event.operation,
      actionId: event.actionId,
      failure: describeFailure(event.failure)
    }
  )
}

function recordRagFailure(event: RagEvent): void {
  if (event.type !== 'operation_failed') {
    const routine: Exclude<RagEvent, FailureEvent<RagEvent>> = event
    void routine
    return
  }
  recordFailure(
    'rag.operation_failed',
    `rag:${event.operation}:${describeFailure(event.failure)}`,
    {
      operation: event.operation,
      failure: describeFailure(event.failure)
    }
  )
}

/** Workflows is a pure failure stream: both of its events are failures. */
function recordWorkflowFailure(event: WorkflowEvent): void {
  if (event.type === 'bridge_failed') {
    recordFailure(
      'workflows.bridge_failed',
      `workflows:bridge_failed:${describeFailure(event.failure)}`,
      {
        bridge: event.bridge,
        failure: describeFailure(event.failure)
      }
    )
    return
  }
  recordFailure(
    'workflows.workflow_failed',
    `workflows:workflow_failed:${describeFailure(event.failure)}`,
    {
      workflow: event.workflow,
      operationId: event.operationId,
      failure: describeFailure(event.failure)
    }
  )
}

/**
 * Every domain, routed to the handler that knows its failure names.
 *
 * The `never` default is the second half of the exhaustiveness check, and it is the one that would
 * have caught this defect: five domains - models, speech, automation, use and workflows - were
 * publishing failures into an observer that admitted only two, and nothing failed. A new domain now
 * fails the type here instead of being silently unobserved.
 */
function observeApplicationFailures(): void {
  releaseFailureObserver ??= desktopApplication.events((published) => {
    switch (published.domain) {
      case 'lifecycle':
        observeLifecycleFailure(published.event)
        return
      case 'models':
        recordModelsFailure(published.event)
        return
      case 'sync':
        recordSyncFailure(published.event)
        return
      case 'speech':
        recordSpeechFailure(published.event)
        return
      case 'automation':
        recordAutomationFailure(published.event)
        return
      case 'use':
        recordUseFailure(published.event)
        return
      case 'rag':
        recordRagFailure(published.event)
        return
      case 'workflows':
        recordWorkflowFailure(published.event)
        return
      default: {
        const unobservedDomain: never = published
        void unobservedDomain
      }
    }
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
