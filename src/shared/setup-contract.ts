// The "Configure for me" plan as both processes see it: the main process builds it and the
// renderer shows it. Pure types and arithmetic only, so the renderer never imports main code.

/** Resource-usage mode "Configure for me" picks for: light, default, or maximal. */
export type RecMode = 'conservative' | 'balanced' | 'extreme'

export type SetupItemKind = 'chat' | 'transcription' | 'voice' | 'image' | 'video' | 'embedding'

export interface SetupItem {
  kind: SetupItemKind
  capability: string // user-facing: "Chat & vision", "Speech-to-text", …
  id: string
  name: string
  sizeGb: number
  installed: boolean
  downloadSizeGb?: number
  files?: { name: string; sizeBytes?: number }[]
  required: boolean // legacy default-plan priority; explicit selections can omit chat
}

export interface SetupPlan {
  mode: RecMode
  ramGb: number
  items: SetupItem[]
  totalDownloadGb: number
  videoNote?: string
  videoRuntimeIssue?: string
  embeddingNote?: string
}

export interface SetupProgress {
  phase: 'select' | 'download' | 'activate' | 'start' | 'verify' | 'done' | 'error'
  message: string
  modelId?: string
  modelName?: string
  percent?: number
  downloadedMB?: string
  totalMB?: string
  downloadedBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
}

/** Sum the download size (GB) of a plan's not-yet-installed items. */
export function totalDownloadGb(
  items: { sizeGb: number; downloadSizeGb?: number; installed: boolean }[]
): number {
  return items.filter((i) => !i.installed).reduce((s, i) => s + (i.downloadSizeGb ?? i.sizeGb), 0)
}
