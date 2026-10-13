// Pure helpers for the composer's active-model indicator. Zero IO so they unit-test
// without the app: format the running context window and resolve a model id to its
// display name. The hook (useActiveModelSummary) does the IPC and delegates here.

import { CATALOG, isMMProjFile } from '@offgrid/models'
import { parseRemoteVisionModelId } from '../../../shared/remote-vision-server'
import { fitLevel } from '../../../shared/model-fit'

/** Support GGUFs are not runnable model choices. */
export function isModelWeightFile(file: { fileName: string }): boolean {
  return (
    file.fileName.toLowerCase().endsWith('.gguf') &&
    !isMMProjFile(file.fileName) &&
    !/(?:^|[/_.-])(?:imatrix|importance[_-]?matrix)(?:[_.-]|$)/i.test(file.fileName)
  )
}

/** File-picker guidance, based on the reported system RAM on every OS.
 * Precision is a format property, not an accuracy benchmark. Never infer speed
 * from file size: CPU/GPU kernels and offload change the result. */
export function modelFileGuidance(
  files: readonly {
    fileName: string
    quant: string
    sizeBytes: number
    mmproj?: { sizeBytes?: number }
  }[],
  ramGb: number | null
): Map<
  string,
  {
    fileName: string
    quant: string
    bits: number | null
    weightBytes: number | null
    totalBytes: number | null
    fit: ReturnType<typeof fitLevel> | null
    split: boolean
    labels: string[]
  }
> {
  const rows = files.filter(isModelWeightFile).map((file) => {
    // Parse the full filename: the provider parser can truncate IQ/XL/BF16 names.
    const quant =
      file.fileName
        .match(
          /(?:^|[-/])((?:BF16|FP16|F16|F32|MXFP4_MOE|(?:IQ|Q)\d+(?:_[A-Z0-9]+)*))(?=\.|-\d{5}-of-|$)/i
        )?.[1]
        ?.toUpperCase() ?? file.quant.toUpperCase()
    const bits = /^(?:BF16|FP16|F16)$/.test(quant)
      ? 16
      : quant === 'F32'
        ? 32
        : quant === 'MXFP4_MOE'
          ? 4
          : Number(quant.match(/^(?:IQ|Q)(\d+)(?:_|$)/)?.[1]) || null
    const split = file.fileName.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i)
    const parts = split
      ? files.filter((part) => {
          const match = part.fileName.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i)
          return match?.[1] === split[1] && match?.[3] === split[3]
        })
      : [file]
    const complete =
      !split ||
      (Number(split[3]) > 0 &&
        Array.from(
          { length: Number(split[3]) },
          (_, i) => `${split[1]}-${String(i + 1).padStart(5, '0')}-of-${split[3]}.gguf`
        ).every((name) => parts.some((part) => part.fileName === name)))
    const knownSize =
      complete && parts.every((part) => Number.isFinite(part.sizeBytes) && part.sizeBytes > 0)
    const weightBytes = knownSize ? parts.reduce((sum, part) => sum + part.sizeBytes, 0) : null
    const companionBytes = file.mmproj?.sizeBytes
    const knownCompanion =
      !file.mmproj || (Number.isFinite(companionBytes) && (companionBytes ?? 0) > 0)
    const totalBytes =
      weightBytes !== null && knownCompanion ? weightBytes + (companionBytes ?? 0) : null
    const fit =
      totalBytes !== null && ramGb !== null && Number.isFinite(ramGb) && ramGb > 0
        ? fitLevel(totalBytes / 1e9, ramGb)
        : null
    return { fileName: file.fileName, quant, bits, weightBytes, totalBytes, fit, split: !!split }
  })
  const eligible = rows.filter(
    (row) => !row.split && row.fit === 'ok' && row.bits !== null && row.bits >= 3
  )
  const balanced = [...eligible].sort(
    (a, b) =>
      Number(b.quant === 'Q4_K_M') - Number(a.quant === 'Q4_K_M') ||
      Math.abs(a.bits! - 4) - Math.abs(b.bits! - 4) ||
      a.totalBytes! - b.totalBytes!
  )[0]
  const smallest = rows
    .filter((row) => !row.split && row.totalBytes !== null && row.bits !== null)
    .sort((a, b) => a.totalBytes! - b.totalBytes!)[0]
  const highestBits = Math.max(0, ...rows.map((row) => row.bits ?? 0))
  return new Map(
    rows.map((row) => [
      row.fileName,
      {
        ...row,
        labels: [
          ...(row.fileName === balanced?.fileName ? ['Best balance'] : []),
          ...(row.bits === highestBits ? ['Highest precision'] : []),
          ...(row.fileName === smallest?.fileName ? ['Smallest download'] : [])
        ]
      }
    ])
  )
}

/** Format a context window in tokens as a compact label, e.g. 8192 -> "8K",
 *  131072 -> "128K". Local model contexts are powers of two, so divide by 1024.
 *  Returns null when unknown/zero so the UI can omit it. */
export function formatContextWindow(tokens?: number | null): string | null {
  if (!tokens || tokens <= 0) {
    return null
  }
  if (tokens < 1024) {
    return String(tokens)
  }
  return `${Math.round(tokens / 1024)}K`
}

/** Parameter count in billions, read the way people say it: 0.082 → "82M", 7 → "7B". */
export function formatParams(billions: number): string {
  return billions < 1 ? `${Math.round(billions * 1000)}M` : `${billions}B`
}

/** Resolve an active model id to its catalog display name; falls back to the id when
 *  the catalog has no match (a just-imported model), null when there is no active id. */
export function resolveModelName(
  models: ReadonlyArray<{ id: string; name?: string }>,
  id: string | null | undefined
): string | null {
  if (!id) {
    return null
  }
  return models.find((m) => m.id === id)?.name ?? parseRemoteVisionModelId(id)?.modelId ?? id
}

/** Name a model by the file it ran from: "dreamshaper-xl-v2-turbo-Q8_0.gguf" reads as the
 *  catalog's name for that download. A file the catalog does not know keeps its own name. */
export function modelNameForFile(file: string | null | undefined): string | null {
  const fileName = file?.split(/[\\/]/).pop()?.trim()
  if (!fileName) return null
  const entry = CATALOG.find((model) =>
    model.files.some((candidate) => candidate.name === fileName)
  )
  return entry?.name ?? resolveModelName([], fileName)
}

interface TextModelSummaryEntry {
  id: string
  name?: string
  kind?: string
  remoteServerId?: string
}

/** Resolve the one active text/vision selection. Remote activation supersedes the
 * local llama-server selection, which may remain loaded as an implementation detail. */
export function resolveActiveTextModel(
  models: ReadonlyArray<TextModelSummaryEntry>,
  localActiveId: string | null | undefined,
  activeIds: ReadonlySet<string>
): { name: string | null; remote: boolean } {
  const remote = models.find(
    (model) =>
      model.remoteServerId &&
      (model.kind === undefined || model.kind === 'text' || model.kind === 'vision') &&
      activeIds.has(model.id)
  )
  if (remote) return { name: remote.name ?? remote.id, remote: true }
  return { name: resolveModelName(models, localActiveId), remote: false }
}
