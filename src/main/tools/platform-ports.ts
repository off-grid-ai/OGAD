import type { ToolEmbeddingExecutionPort } from '@offgrid/models'
import { llm } from '../llm'
import { readImages } from '../llm/read-images'

/** Desktop engine and settings I/O only. Shared owns every routing decision. */
export const desktopToolEmbeddingPort: ToolEmbeddingExecutionPort = {
  async embed(inputs) {
    const { embeddings } = await import('../embeddings')
    return Promise.all(inputs.map((input) => embeddings.generateEmbedding(input)))
  }
}

export function desktopToolContextSize(): number {
  return llm.effectiveContextSize()
}

export function desktopToolCallLimit(): number | undefined {
  return llm.getSettings().maxToolCalls
}

/** Native projector probe plus filesystem decoding at one platform boundary. */
export function readSupportedToolImages(paths: readonly string[]): ReturnType<typeof readImages> {
  return paths.length && llm.hasVision() ? readImages([...paths]) : []
}
