import type { AnalyticsProperties } from './properties'

/**
 * The daily `usage_snapshot`: how much of each thing exists on this device, rounded down to a
 * step of one scale shared with OGAM (an exact count can tell one install from another), and
 * never a name or an id.
 */
export const COUNT_STEPS = [0, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000] as const

export function countBucket(count: number): number {
  if (!Number.isFinite(count) || count < 1) return 0
  let step = 0
  for (const value of COUNT_STEPS) if (count >= value) step = value
  return step
}

/** The counts in the snapshot, named as OGAM names them. Pro adds films and paired devices. */
export const USAGE_COUNTS = [
  'chats',
  'messages',
  'user_messages',
  'projects',
  'knowledge_documents',
  'generated_images',
  'generated_videos',
  'films',
  'mcp_servers',
  'paired_devices',
  'remote_servers',
  'models_text',
  'models_vision',
  'models_image',
  'models_video',
  'models_tts',
  'models_stt',
  'models_embedding'
] as const
export type UsageCount = (typeof USAGE_COUNTS)[number]

/** A model kind from storage, as a snapshot count. Anything else is not counted. */
export function modelCountKey(kind: string | undefined): UsageCount | null {
  switch (kind) {
    case 'text':
      return 'models_text'
    case 'vision':
      return 'models_vision'
    case 'image':
      return 'models_image'
    case 'video':
      return 'models_video'
    case 'voice':
    case 'speech':
      return 'models_tts'
    case 'transcription':
      return 'models_stt'
    case 'embedding':
      return 'models_embedding'
    default:
      return null
  }
}

export type UsageCountSource = () =>
  Partial<Record<UsageCount, number>> | Promise<Partial<Record<UsageCount, number>>>

export interface AppearanceSnapshot {
  theme?: string
  ui_animations?: boolean
  zoom_level?: number
}

/**
 * Every count bucketed, plus the appearance settings. A count no source reported is left out
 * rather than sent as zero: unknown is not none.
 */
export async function buildUsageSnapshot(
  sources: Iterable<UsageCountSource>,
  appearance: AppearanceSnapshot
): Promise<AnalyticsProperties> {
  const counts: Partial<Record<UsageCount, number>> = {}
  for (const source of sources) {
    try {
      for (const [key, value] of Object.entries(await source())) {
        if (!(USAGE_COUNTS as readonly string[]).includes(key)) continue
        if (typeof value !== 'number' || !Number.isFinite(value)) continue
        counts[key as UsageCount] = (counts[key as UsageCount] ?? 0) + value
      }
    } catch {
      /* a failing source leaves its counts out */
    }
  }
  const snapshot: AnalyticsProperties = {}
  for (const key of USAGE_COUNTS) {
    const value = counts[key]
    if (value !== undefined) snapshot[key] = countBucket(value)
  }
  if (appearance.theme === 'system' || appearance.theme === 'light' || appearance.theme === 'dark')
    snapshot.theme = appearance.theme
  if (typeof appearance.ui_animations === 'boolean')
    snapshot.ui_animations = appearance.ui_animations
  // Page zoom in half steps, as the zoom keys move it; clamped so an odd value cannot stand out.
  if (typeof appearance.zoom_level === 'number' && Number.isFinite(appearance.zoom_level))
    snapshot.zoom_level = Math.max(-5, Math.min(5, Math.round(appearance.zoom_level * 2) / 2))
  return snapshot
}
