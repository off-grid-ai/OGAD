import type {
  ModelCatalogEntry,
  ModelKind,
  ModelsActivateResponse,
  ModelsInventoryResponse
} from './bridge-media-protocol'

const KINDS: readonly string[] = ['text', 'image', 'computer_use', 'voice', 'transcription']
const optString = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const optNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function catalogEntry(raw: unknown): ModelCatalogEntry[] {
  if (!isObject(raw) || !optString(raw.id)) {
    return []
  }
  const files = Array.isArray(raw.files) ? raw.files.filter(isObject) : []
  const kind = [...KINDS, 'vision', 'chat'].includes(String(raw.kind))
    ? (raw.kind as ModelCatalogEntry['kind'])
    : 'other'
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === 'string')
    : []
  const org = optString(raw.org)
  const params = typeof raw.params === 'number' ? `${raw.params}B` : optString(raw.params)
  const minRamGb = optNumber(raw.minRamGb)
  const note = optString(raw.availabilityNote)
  return [
    {
      id: raw.id as string,
      name: optString(raw.name) ?? String(raw.id),
      kind,
      tags,
      sizeBytes: files.reduce((total, file) => total + (optNumber(file.sizeBytes) ?? 0), 0),
      comingSoon: raw.availability === 'coming_soon',
      remote: Boolean(optString(raw.remoteServerId)),
      vision: kind === 'vision' || tags.some((tag) => tag.toLowerCase() === 'vision'),
      files: files.flatMap((file) => (optString(file.name) ? [String(file.name)] : [])),
      ...(org ? { org } : {}),
      ...(params ? { params } : {}),
      ...(minRamGb === undefined ? {} : { minRamGb }),
      ...(note ? { note } : {})
    }
  ]
}

/** Select only the fields the extension uses; server keys and local paths stay here. */
export async function readModelInventory(): Promise<ModelsInventoryResponse> {
  const mm = await import('../models-manager')
  const { getTaskRolesView } = await import('../vision/vision-task-model-strategy')
  const [catalog, installed, activeIds, taskRoles] = await Promise.all([
    mm.getCatalog(),
    mm.listInstalled(),
    mm.getActiveModelIds(),
    getTaskRolesView()
  ])
  const active = mm.getActiveModalities()
  return {
    catalog: catalog.models.flatMap(catalogEntry),
    installed,
    active: {
      text: active.text,
      image: active.image,
      computer_use: active.computer_use,
      voice: active.speech,
      transcription: active.transcription
    },
    activeIds,
    taskRoles
  }
}

export async function activateBridgeModel(
  params: Record<string, unknown>
): Promise<ModelsActivateResponse> {
  if (
    Object.keys(params).some((key) => !['id', 'kind'].includes(key)) ||
    typeof params.id !== 'string' ||
    !params.id ||
    params.id.length > 400 ||
    /\s/.test(params.id) ||
    typeof params.kind !== 'string' ||
    !KINDS.includes(params.kind)
  ) {
    throw new Error('invalid')
  }
  const { activateModelFromRequest } = await import('../model-activation-request')
  const result = await activateModelFromRequest(params.id, params.kind as ModelKind)
  if (!result.success) {
    throw new Error(result.error ?? 'Model activation failed.')
  }
  return { success: true }
}
