/** Desktop composition root. Shared owns application behavior; Desktop supplies device I/O. */
import { randomUUID } from 'node:crypto'
import { createOffGridApplication } from '@offgrid/application'
import { DEFAULT_RAG_EMBEDDING_DIMENSION } from '@offgrid/rag'
import { desktopModelWorkspace } from '../model-services'
import { embeddings } from '../embeddings'
import { desktopExtraction } from '../rag/extractors'
import { desktopVectorStore, projectExists } from '../rag/store'
import { applicationShutdown } from '../shutdown'
import { registerDesktopApplication } from './application-access'
import { desktopSyncStatePort } from '../sync-state-port'
import {
  createDesktopAutomationPorts,
  forwardDesktopAutomationEvent
} from '../tasks/task-history'
import { createDesktopUsePorts, observeActionOutcome } from '../actions/use-runtime'
import { createDesktopGuidedSetupPorts } from './guided-setup'

export const desktopApplication = createOffGridApplication({
  models: { workspace: desktopModelWorkspace, guidedSetup: createDesktopGuidedSetupPorts() },
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
  pro: { sync: { state: desktopSyncStatePort } },
  newId: randomUUID
})

registerDesktopApplication(desktopApplication)
desktopApplication.automation.events(forwardDesktopAutomationEvent)
desktopApplication.use.events((event) => {
  if (event.type === 'action_outcome') observeActionOutcome(event.outcome)
})

let starting: ReturnType<typeof desktopApplication.start> | null = null

export function startDesktopApplication(): ReturnType<typeof desktopApplication.start> {
  starting ??= desktopApplication.start()
  return starting
}

export async function stopDesktopApplication(): Promise<void> {
  await desktopApplication.stop()
  starting = null
}

applicationShutdown.register({ name: 'core:application', shutdown: stopDesktopApplication })
