// Composition root: shared tool routing over Desktop's embedding engine.
import { PersistentToolEmbeddingCache, ToolRoutingService } from '@offgrid/models'
import { desktopToolEmbeddingPort } from '../tools/platform-ports'
import { once } from '@offgrid/models'

export const toolRoutingService = once(
  () =>
    new ToolRoutingService({
      embedding: desktopToolEmbeddingPort,
      // Desktop keeps no tool-embedding cache on disk yet.
      embeddingCache: new PersistentToolEmbeddingCache({
        read: async () => undefined,
        write: async () => undefined
      })
    })
)
