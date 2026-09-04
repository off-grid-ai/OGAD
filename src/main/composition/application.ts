/** Desktop composition root. Shared owns application behavior; Desktop supplies device I/O. */
import { randomUUID } from 'node:crypto'
import {
  createOffGridApplication,
  observeApplicationFailures as observeFailures,
  type ApplicationDegradation,
  type OffGridApplicationSnapshot
} from '@offgrid/application'
import { DEFAULT_RAG_EMBEDDING_DIMENSION } from '@offgrid/rag'
import { desktopModelWorkspacePorts } from '../model-services'
import { desktopModelLibraryPorts, resolveDesktopActivation } from '../models-manager'
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
import { setupVoiceTurnIpc } from '../voice-turn-ipc'
import { desktopModelDownloads } from '../models/desktop-model-download-ports'
import { createDesktopModelControlPort } from '../models/desktop-model-control-port'

const speechIo = createDesktopSpeechIoPorts()
const extensionPorts = consumeDesktopApplicationExtensionPorts()

export const desktopApplication = createOffGridApplication({
  models: {
    // The workspace's own I/O and this device's adapters, not a workspace: shared's root composes
    // the single one from these and registers the adapters into it. Desktop holds no instance, so
    // there is exactly one routing owner and one residency owner on the device. The platform
    // contract accepts ports only, so Desktop cannot hand a second workspace into the root.
    ...desktopModelWorkspacePorts,
    downloads: desktopModelDownloads.ports,
    control: createDesktopModelControlPort(),
    guidedSetup: createDesktopGuidedSetupPorts(),
    activation: { resolve: resolveDesktopActivation },
    library: desktopModelLibraryPorts,
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
  releaseAutomationForwarder ??= desktopApplication.automation.events((event) => {
    // Operational failures are already consumed by the shared failure observer. Task history owns
    // only durable and live task mutations, so it must not receive the facade's failure envelope.
    if (event.type !== 'operation_failed') forwardDesktopAutomationEvent(event)
  })
  releaseUseForwarder ??= desktopApplication.use.events((event) => {
    if (event.type === 'action_outcome') observeActionOutcome(event.outcome)
  })
}

/**
 * Where a failure line goes. Shared owns which events are failures, what each one is called, what
 * correlates it and how a repeating run is capped; the only thing left that is genuinely desktop's
 * is the bounded diagnostic writer it ends up in.
 */
function observeApplicationFailures(): void {
  releaseFailureObserver ??= observeFailures(desktopApplication, (failure) =>
    writeDiagnosticLog(
      'application',
      `${failure.domain}.${failure.event}`,
      {
        ...failure.fields,
        operation: failure.operation,
        identity: failure.identity,
        summary: failure.summary
      },
      'error'
    )
  )
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
