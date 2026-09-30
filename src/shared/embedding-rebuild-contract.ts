export interface EmbeddingRebuildStatus {
  phase: 'idle' | 'preparing' | 'rebuilding' | 'done' | 'error'
  model: string
  done: number
  total: number
  error?: string
}
