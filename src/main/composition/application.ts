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
import { connectDesktopRagMutations } from './rag'

export const desktopApplication = createOffGridApplication({
  models: { workspace: desktopModelWorkspace },
  rag: {
    store: desktopVectorStore,
    embeddings: {
      dimension: DEFAULT_RAG_EMBEDDING_DIMENSION,
      embed: (text) => embeddings.generateEmbedding(text)
    },
    extraction: desktopExtraction,
    projectExists: async (projectId) => projectExists(projectId)
  },
  newId: randomUUID
})

registerDesktopApplication(desktopApplication)

let starting: ReturnType<typeof desktopApplication.start> | null = null
let disconnectRagMutations: (() => void) | null = null

export function startDesktopApplication(): ReturnType<typeof desktopApplication.start> {
  starting ??= desktopApplication.start().then((result) => {
    disconnectRagMutations ??= connectDesktopRagMutations(desktopApplication.rag)
    return result
  })
  return starting
}

export async function stopDesktopApplication(): Promise<void> {
  disconnectRagMutations?.()
  disconnectRagMutations = null
  await desktopApplication.stop()
  starting = null
}

applicationShutdown.register({ name: 'core:application', shutdown: stopDesktopApplication })
