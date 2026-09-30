import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isValidGgufFile } from './models/gguf'
import { CATALOG } from '@offgrid/models'

const knownPackages = CATALOG.filter((entry) =>
  entry.files.some((file) => file.name.toLowerCase().endsWith('.gguf'))
)

// These weights use other bundled runtimes. A GGUF header alone does not make
// an image, video, audio, or embedding weight loadable by llama-server.
const nonChatWeightName =
  /(?:qwen[-_]?image|z[-_]?image|flux|stable[-_]?diffusion|sd3|wan[-_]?2|ltx[-_]?video|hunyuan[-_]?video|whisper|piper|kokoro|mini[-_]?lm|(?:^|[-_])bge[-_])/i

function matchingPackage(file: string): (typeof CATALOG)[number] | undefined {
  const name = path.basename(file).toLowerCase()
  return knownPackages.find((entry) =>
    entry.files.some(
      (part) => part.role !== 'mmproj' && path.basename(part.name).toLowerCase() === name
    )
  )
}

export interface ExternalModel {
  id: string
  name: string
  primary: string
  mmproj?: string
  kind: 'text' | 'vision'
  sizeBytes: number
  source: 'LM Studio' | 'Ollama' | 'Selected folder' | 'Added folder'
}

function model(
  file: string,
  name: string,
  source: ExternalModel['source'],
  projector?: string
): ExternalModel | null {
  try {
    const resolved = fs.realpathSync(file)
    if (!fs.statSync(resolved).isFile() || !isValidGgufFile(resolved, fs)) return null
    const mmproj =
      projector && isValidGgufFile(projector, fs) ? fs.realpathSync(projector) : undefined
    return {
      id: `external:${createHash('sha256').update(`${source}\0${resolved}`).digest('hex')}`,
      name,
      primary: resolved,
      ...(mmproj ? { mmproj } : {}),
      kind: mmproj ? 'vision' : 'text',
      sizeBytes: fs.statSync(resolved).size,
      source
    }
  } catch {
    return null
  }
}

function scanGgufTree(
  root: string,
  source: ExternalModel['source'],
  nestedOnly = false
): ExternalModel[] {
  const grouped = new Map<string, string[]>()
  walk(root, 4, (file) => {
    if (!/\.gguf$/i.test(file) || (nestedOnly && !path.relative(root, file).includes(path.sep)))
      return
    const directory = path.dirname(file)
    grouped.set(directory, [...(grouped.get(directory) ?? []), file])
  })
  const found: ExternalModel[] = []
  for (const files of grouped.values()) {
    const projectors = files.filter((file) => /(?:mmproj|projector)/i.test(path.basename(file)))
    const weights = files.filter((file) => !projectors.includes(file))
    for (const file of files) {
      if (projectors.includes(file)) continue
      const known = matchingPackage(file)
      // Image, video, speech, and Computer Use packages need their own runtime
      // and companions. Never offer one of their weights to the chat engine.
      if (
        (known && known.kind !== 'text' && known.kind !== 'vision') ||
        nonChatWeightName.test(path.basename(file))
      )
        continue
      const expectedProjector = known?.files.find((part) => part.role === 'mmproj')
      const matchedProjector = expectedProjector
        ? projectors.find(
            (part) =>
              path.basename(part).toLowerCase() ===
              path.basename(expectedProjector.name).toLowerCase()
          )
        : projectors.length === 1 && weights.length === 1
          ? projectors[0]
          : undefined
      if (expectedProjector && !matchedProjector) continue
      const item = model(file, path.basename(file, path.extname(file)), source, matchedProjector)
      if (item) found.push(item)
    }
  }
  return found
}

function walk(root: string, depth: number, visit: (file: string) => void): void {
  if (depth < 0) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) walk(file, depth - 1, visit)
    else if (entry.isFile()) visit(file)
  }
}

export function discoverExternalModels(
  home = os.homedir(),
  ollamaRoot = process.env.OLLAMA_MODELS,
  selectedRoot?: string,
  extraRoots: string[] = []
): ExternalModel[] {
  const found: ExternalModel[] = []
  const lmRoot = path.join(home, '.lmstudio', 'models')
  found.push(...scanGgufTree(lmRoot, 'LM Studio'))
  if (selectedRoot && path.resolve(selectedRoot) !== path.resolve(lmRoot)) {
    found.push(...scanGgufTree(selectedRoot, 'Selected folder', true))
  }
  for (const root of extraRoots) {
    found.push(...scanGgufTree(root, 'Added folder'))
  }
  const roots = [ollamaRoot, path.join(home, '.ollama', 'models'), ...extraRoots]
  if (process.platform === 'linux') roots.push('/usr/share/ollama/.ollama/models')
  for (const root of new Set(roots.filter((value): value is string => Boolean(value)))) {
    const manifestRoot = path.join(root, 'manifests')
    walk(manifestRoot, 5, (file) => {
      try {
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as {
          layers?: Array<{ mediaType?: string; digest?: string }>
        }
        const weights =
          manifest.layers?.filter(
            (layer) => layer.mediaType === 'application/vnd.ollama.image.model'
          ) ?? []
        const weight = weights[0]
        if (weights.length !== 1 || !weight || !/^sha256:[a-f0-9]{64}$/i.test(weight.digest ?? ''))
          return
        const dashed = path.join(root, 'blobs', weight.digest!.replace(':', '-'))
        const blob = fs.existsSync(dashed) ? dashed : path.join(root, 'blobs', weight.digest!)
        const projectorLayers =
          manifest.layers?.filter(
            (layer) => layer.mediaType === 'application/vnd.ollama.image.projector'
          ) ?? []
        const projectorDigest =
          projectorLayers.length === 1 ? projectorLayers[0]?.digest : undefined
        const projector =
          projectorDigest && /^sha256:[a-f0-9]{64}$/i.test(projectorDigest)
            ? (() => {
                const dashedPath = path.join(root, 'blobs', projectorDigest.replace(':', '-'))
                return fs.existsSync(dashedPath)
                  ? dashedPath
                  : path.join(root, 'blobs', projectorDigest)
              })()
            : undefined
        const name = path.relative(manifestRoot, file).split(path.sep).slice(1).join('/')
        const item = model(blob, name, 'Ollama', projector)
        if (item) found.push(item)
      } catch {
        /* skip incomplete manifests */
      }
    })
  }
  const unique = new Map<string, ExternalModel>()
  for (const item of found) if (!unique.has(item.primary)) unique.set(item.primary, item)
  return [...unique.values()]
}
