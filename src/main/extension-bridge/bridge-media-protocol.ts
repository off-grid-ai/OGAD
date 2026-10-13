// Browser-safe wire types for the sealed model and audio methods.
export type ModelKind = 'text' | 'image' | 'computer_use' | 'voice' | 'transcription'
export type EmptyRequest = Record<string, never>
export interface ModelCatalogEntry {
  id: string
  name: string
  kind: ModelKind | 'vision' | 'chat' | 'other'
  org?: string
  params?: string
  minRamGb?: number
  tags: string[]
  sizeBytes: number
  comingSoon: boolean
  remote: boolean
  vision: boolean
  files: string[]
  note?: string
}
export interface ModelTaskRoles {
  tasks: readonly {
    task: 'computer_use' | 'web_use'
    taskLabel: string
    strategyLabel: string
    slots: readonly {
      role: 'reasoner' | 'decision' | 'grounding_specialist'
      label: string
      does: string
      modelId: string
      modelName: string
      remote: boolean
    }[]
  }[]
  badges: Readonly<Record<string, string>>
}
export interface ModelsInventoryResponse {
  catalog: ModelCatalogEntry[]
  installed: string[]
  active: Record<ModelKind, string | null>
  activeIds: string[]
  taskRoles: ModelTaskRoles
}
export interface ModelsActivateRequest {
  id: string
  kind: ModelKind
}
export interface ModelsActivateResponse {
  success: true
}
export interface AudioVoicesResponse {
  voices: string[]
}
export interface AudioTranscribeRequest {
  audio: string
  mimeType: string
}
export interface AudioTranscribeResponse {
  text: string
}
export interface AudioSpeakRequest {
  text: string
  voice?: string
}
export interface AudioSpeakResponse {
  audio: string
  mimeType: string
}
