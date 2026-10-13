export interface EmbeddingRebuildStatus {
  phase: 'idle' | 'preparing' | 'rebuilding' | 'restored' | 'done' | 'error'
  model: string
  done: number
  total: number
  error?: string
}
