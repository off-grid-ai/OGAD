import { reportDownloadStatus } from './analytics'
import { totalmem } from 'os'
import { settingsChanged, settingsVersion } from './settings-version'
import { withStorageDownload } from './model-storage-guard'
// Central model management — the single source of truth for catalog, install
// listing, download (pull), delete, and activation. Used by BOTH the desktop IPC
// handlers (UI) AND the headless gateway HTTP admin endpoints, so the full
// repertoire (pull / delete / activate / list) works with or without a UI.
import fs from 'fs'
import path from 'path'
import { llm } from './llm'
import { isValidGgufFile } from './models/gguf'
import { readGgufMtpSupport, readGgufTemplateTraits } from './models/gguf-metadata'
import { pumpToFile } from './models/download-pump'
import { downloadIntegrityError, sha256IntegrityError } from './models/download-verify'
import { downloadFailureMessage, isStorageCapacityError } from './models/download-error'
import {
  DOWNLOAD_INTERRUPTED_ERROR,
  modelDownloadQueue,
  shutdownModelDownloads
} from './models/download-queue'
import {
  getAllActiveModals,
  setActiveModal as setModal,
  setRemoteModelSelected,
  type Modality
} from './active-models'
import {
  readDownloaded,
  recordDownloaded,
  removeDownloaded,
  findDownloaded,
  installedDownloadedIds,
  downloadedProtectedNames,
  reconcileDownloadedModelRegistry,
  downloadedModelKind,
  type DownloadedModel
} from './downloaded-models'
import {
  MTP_COMPANIONS,
  selectedGgufParts,
  mergeCatalog,
  remainingDownloadBytes,
  installedIds,
  buildDiskEntry,
  primaryFileName,
  protectedNames,
  scanModelDir,
  modalityForModel,
  modalSelectionMatches,
  isChatLoadable,
  visionStatus,
  projectorToHeal,
  isProjectorFileName,
  type CatalogEntry,
  type VisionStatus
} from './models/catalog-logic'
import { writeDiagnosticLog } from './diagnostics-log'
import { installKevRuntime, installedKevRuntimeRoot, kevRuntimeAsset } from './kev-runtime-pack'
import {
  modelPackageIdentity,
  modelTransferManifestFileError,
  type TransferredModelManifest
} from '@offgrid/sync'
import { sampleProgressRate, type ProgressRateSample } from '@offgrid/ui'
import {
  describeModel,
  modelDisplayName,
  mtpHeadForPrimaryFile,
  type ModelEntry,
  type ModelNameSources
} from '@offgrid/models'
import { baseCatalogModels, remoteCatalogModels } from './models/remote-catalog'
import {
  parseRemoteVisionModelId,
  remoteVisionInventoryModels,
  remoteVisionModelId
} from '../shared/remote-vision-server'
import {
  activateRemoteVisionModel,
  activateRemoteVisionMediaModel,
  deactivateRemoteVisionMediaModel,
  getRemoteVisionServerSettings,
  remoteServerIdFor
} from './vision/remote-vision-server'
import { getComputerUseSettings, setComputerUseSettings } from './computer-use-settings'
import { getWebUseSettings, setWebUseSettings } from './web-use-settings'
import { clearTaskRolesFor, setTaskRoleModel } from './task-role-models'
import { strategyTaskRoles } from '../shared/computer-use-settings'
import { binRoots, dataDir, modelStorageError, requireModelStorage } from './runtime-env'
import { discoverExternalModels } from './external-models'
import {
  modelMetadataFile,
  modelReadDirectories,
  resolveModelAsset,
  resolveModelReference
} from './model-paths'
import { readModelScanFolders } from './model-storage-choice'

// Desktop ships the Prism llama.cpp engine required by these packed weights.
// Keep this entry here: the shared catalog also feeds Mobile, whose llama.rn
// runtime cannot load Bonsai 2 yet.
export const BONSAI_2: ModelEntry = {
  id: 'prism-ml/Ternary-Bonsai-2-27B-gguf',
  name: 'Bonsai 2 27B',
  kind: 'vision',
  org: 'Prism ML',
  description: 'Compact 27B reasoning model with optional vision; uses the bundled Prism engine.',
  params: 27,
  // Qwen 3.8 27B in ternary weights: below the full model (34), above every 9B.
  quality: 24,
  minRamGb: 16,
  quant: 'PQ2_0',
  tags: [],
  isNew: true,
  releaseDate: '2026-09-17',
  files: [
    {
      name: 'Ternary-Bonsai-2-27B-PQ2_0.gguf',
      url: 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/6ed5e12bf84b7a63069882c91dd9e9218647d17b/Ternary-Bonsai-2-27B-PQ2_0.gguf',
      sizeBytes: 7206168928,
      sha256: '3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1',
      role: 'primary'
    },
    {
      name: 'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf',
      url: 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/6ed5e12bf84b7a63069882c91dd9e9218647d17b/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf',
      sizeBytes: 629246976,
      sha256: '6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903',
      role: 'mmproj'
    }
  ]
}

// Bonsai 2 9B: Qwen 3.5 9B in packed ternary weights, 2.4GB, from the same Prism engine as the 27B.
// The strongest model for an 8GB Mac. Desktop only: phones do not ship PrismML's llama.cpp fork.
export const BONSAI_2_9B: ModelEntry = {
  id: 'prism-ml/Ternary-Bonsai-2-9B-gguf',
  name: 'Bonsai 2 9B',
  kind: 'vision',
  org: 'Prism ML',
  description: 'A 9B model in 2.4 GB; reads images; uses the bundled Prism engine.',
  params: 9,
  quality: 15,
  minRamGb: 8,
  quant: 'PQ2_0',
  tags: [],
  isNew: true,
  releaseDate: '2026-09-23',
  files: [
    {
      name: 'Ternary-Bonsai-2-9B-PQ2_0.gguf',
      url: 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-9B-gguf/resolve/5b2abb02362efbed46bbe204014b02837778b2c2/Ternary-Bonsai-2-9B-PQ2_0.gguf',
      sizeBytes: 2416851840,
      sha256: '7a89ab48f5038c704480f60781f9b8d4035351f5f6beb7d11fad80001fde23f9',
      role: 'primary'
    },
    {
      name: 'Ternary-Bonsai-2-9B-mmproj-Q8_0.gguf',
      url: 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-9B-gguf/resolve/5b2abb02362efbed46bbe204014b02837778b2c2/Ternary-Bonsai-2-9B-mmproj-Q8_0.gguf',
      sizeBytes: 624229664,
      sha256: 'e0cb6f6988cea323ef798cd77d019bbb819af75582f034eaab0e7232314953db',
      role: 'mmproj'
    }
  ]
}

// Desktop-only typed Decision model. It uses the bundled llama.cpp raw
// completion endpoint and stays in the existing Computer Use catalog without
// becoming the selected visual grounder.
export const DECIDER_2B: ModelEntry = {
  id: 'cosetoenor/decider-2b-GGUF',
  name: 'Decider 2B',
  kind: 'computer_use',
  org: 'Mapika',
  description: 'Fast typed action decisions with calibrated option probabilities.',
  params: 2,
  minRamGb: 4,
  quant: 'Q8_0',
  tags: ['Decision', 'Decider', 'Fast'],
  grounder: false,
  isNew: true,
  releaseDate: '2026-09-19',
  files: [
    {
      name: 'decider-2b-v10-q8_0.gguf',
      url: 'https://huggingface.co/cosetoenor/decider-2b-GGUF/resolve/dcc6e5537f922266d1126c15682ac0929517ee33/decider-2b-q8_0.gguf',
      sizeBytes: 2012012576,
      sha256: 'cc136df323a0d10745447c3cb429a5978a3aa24bd261c00b85bdcba92b859184',
      role: 'primary'
    }
  ]
}

export const DECIDER_2B_VISION: ModelEntry = {
  id: 'mradermacher/decider-2b-vision-GGUF',
  sourceModelId: 'Mapika/decider-2b-vision',
  name: 'Decider 2B Vision',
  kind: 'computer_use',
  org: 'Mapika',
  description: 'Fast typed action decisions from accessibility text and the current screenshot.',
  params: 2,
  minRamGb: 4,
  quant: 'Q4_K_M',
  tags: ['Decision', 'Decider', 'Vision', 'Fast'],
  grounder: false,
  isNew: true,
  releaseDate: '2026-09-19',
  files: [
    {
      name: 'decider-2b-vision.Q4_K_M.gguf',
      url: 'https://huggingface.co/mradermacher/decider-2b-vision-GGUF/resolve/a813595a7a92e358d1741bf973d363be4da77db9/decider-2b-vision.Q4_K_M.gguf',
      sizeBytes: 1274397056,
      sha256: 'b3e38aa90856d6b93df0d2b186e941e57fa6fd4b022a3a89fe538ff01ebd9985',
      role: 'primary'
    },
    {
      name: 'decider-2b-vision.mmproj-Q8_0.gguf',
      url: 'https://huggingface.co/mradermacher/decider-2b-vision-GGUF/resolve/a813595a7a92e358d1741bf973d363be4da77db9/decider-2b-vision.mmproj-Q8_0.gguf',
      sizeBytes: 364664448,
      sha256: '79e636085e90f1b4bdc5df22003cde0dd0d88086a04b7c101e6bd7d1cc9f2c91',
      role: 'mmproj'
    }
  ]
}

export const KEV_4B_ID = 'jaredpalmer/kev-4b'
export const KEV_9B_ID = 'jaredpalmer/kev-9b'

/** A pinned file of a Kev release: where it lives, and its exact bytes. */
interface KevFile {
  readonly file: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly role: 'primary' | 'aux' | 'tokenizer'
}

/**
 * One Kev release: a LoRA checkpoint plus pointer head over a Qwen3.5 base in SafeTensors. Its files
 * live under kev-<size>/checkpoint-v1.0/ and kev-<size>/base/ in the models folder.
 */
function kevEntry(spec: {
  readonly size: string
  readonly id: string
  readonly revision: string
  readonly baseRepo: string
  readonly baseRevision: string
  readonly params: number
  readonly minRamGb: number
  readonly tags: string[]
  readonly releaseDate: string
  readonly checkpoint: readonly KevFile[]
  readonly base: readonly KevFile[]
}): ModelEntry {
  const pinned = (folder: string, repo: string, revision: string) => (file: KevFile) => ({
    name: `kev-${spec.size}/${folder}/${file.file}`,
    url: `https://huggingface.co/${repo}/resolve/${revision}/${file.file}`,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    role: file.role
  })
  return {
    id: spec.id,
    name: `Kev ${spec.size.toUpperCase()}`,
    kind: 'computer_use',
    org: 'Jared Palmer',
    description: 'Local pointer-head model for typed Computer Use decisions.',
    params: spec.params,
    minRamGb: spec.minRamGb,
    tags: spec.tags,
    grounder: false,
    isNew: true,
    releaseDate: spec.releaseDate,
    files: [
      ...spec.checkpoint.map(pinned('checkpoint-v1.0', spec.id, spec.revision)),
      ...spec.base.map(pinned('base', spec.baseRepo, spec.baseRevision))
    ]
  }
}

/** The Qwen3.5 tokenizer, identical across the 4B and 9B bases. */
const QWEN35_TOKENIZER: readonly KevFile[] = [
  {
    file: 'merges.txt',
    sizeBytes: 3353259,
    sha256: 'a9d356d7bdf1ef4949e3e748e95b8e10ad9d4e2e838eddc38a0a7b6b94d1db8d',
    role: 'tokenizer'
  },
  {
    file: 'tokenizer.json',
    sizeBytes: 12807196,
    sha256: 'fe000e3ed39ed12b8d2481d527d44f93c65d37e87645d2dcc80d1bf9d50d2927',
    role: 'tokenizer'
  },
  {
    file: 'tokenizer_config.json',
    sizeBytes: 16713,
    sha256: '3891e840d7dc5fca0af33d3a25083a735e36fe06214e3f707024820cb6b9f89c',
    role: 'tokenizer'
  },
  {
    file: 'vocab.json',
    sizeBytes: 6722759,
    sha256: 'ce99b4cb2983d118806ce0a8b777a35b093e2000a503ebde25853284c9dfa003',
    role: 'tokenizer'
  }
]
const tokenizer = (name: string): KevFile => QWEN35_TOKENIZER.find((file) => file.file === name)!

const KEV_4B = kevEntry({
  size: '4b',
  id: KEV_4B_ID,
  revision: '591dcb5bd6d05eb0b5131ea6608f93f10243335c',
  baseRepo: 'Qwen/Qwen3.5-4B-Base',
  baseRevision: '1001bb4d826a52d1f399e183466143f4da7b741b',
  params: 4,
  minRamGb: 16,
  tags: ['Decision', 'Decider', 'Fast'],
  releaseDate: '2026-10-01',
  checkpoint: [
    {
      file: 'head.pt',
      sizeBytes: 5249791,
      sha256: 'dd633435998ecc751ac538717a3742e32149500fabf7d7276287dbf0693f347c',
      role: 'primary'
    },
    {
      file: 'adapter_config.json',
      sizeBytes: 1271,
      sha256: '8a05dfd6c5e7f61a62e6db5d8de8093a8dbbd105aa7ee7b5e7b73f6249f45617',
      role: 'aux'
    },
    {
      file: 'adapter_model.safetensors',
      sizeBytes: 129924032,
      sha256: '90e817356246e7f18bfa7ca3d31794cd4fbeb3332a66a84cb51d9ceae925f2b2',
      role: 'aux'
    }
  ],
  base: [
    {
      file: 'config.json',
      sizeBytes: 3161,
      sha256: 'ddc63e1c717afa86c865bb5e01313d89d72bb53b97ad4a8a03ba8510c0621670',
      role: 'aux'
    },
    tokenizer('merges.txt'),
    {
      file: 'model.safetensors-00001-of-00002.safetensors',
      sizeBytes: 5329398712,
      sha256: 'df547074dce70532a0493e5433152bd17a65efb89088cfabc2e7e2371a93d712',
      role: 'aux'
    },
    {
      file: 'model.safetensors-00002-of-00002.safetensors',
      sizeBytes: 3990429344,
      sha256: '590fbaac095dd31db886c322d9d2f7df47777966391acf306ddddc3e4e3a15ef',
      role: 'aux'
    },
    {
      file: 'model.safetensors.index.json',
      sizeBytes: 76196,
      sha256: 'eae340074abb0a5f31a6621f7ae8e8248a7c1790df04a722c4e4b70c2a6d1dbb',
      role: 'aux'
    },
    tokenizer('tokenizer.json'),
    tokenizer('tokenizer_config.json'),
    tokenizer('vocab.json')
  ]
})

/** Kev on Qwen3.5-9B-Base (base revision pinned in the release's provenance.json). BF16 weights
 *  are 19.3 GB, so it needs a machine with room for them beside the app. */
const KEV_9B = kevEntry({
  size: '9b',
  id: KEV_9B_ID,
  revision: 'db029f08b290afd9fee4aa4bbcd9ae48602d1eb0',
  baseRepo: 'Qwen/Qwen3.5-9B-Base',
  baseRevision: '68c46c4b3498877f3ef123c856ecfde50c39f404',
  params: 9,
  minRamGb: 32,
  tags: ['Decision', 'Decider'],
  releaseDate: '2026-10-18',
  checkpoint: [
    {
      file: 'head.pt',
      sizeBytes: 8395071,
      sha256: '8e1dab2c8e3664f6fee843e0257d57946c25e0210c61901ea77e71761f4244e1',
      role: 'primary'
    },
    {
      file: 'adapter_config.json',
      sizeBytes: 1271,
      sha256: '2b2563a94d1bc1065653bec4d296f5a1a6287ab895b14d23e5997333503ecd97',
      role: 'aux'
    },
    {
      file: 'adapter_model.safetensors',
      sizeBytes: 173178096,
      sha256: '2b2a70cf4ef4440b6c22899e1f72c2f8ea5c6f65b19aa344539b4b8971d1f13d',
      role: 'aux'
    }
  ],
  base: [
    {
      file: 'config.json',
      sizeBytes: 3126,
      sha256: 'd0883072e01861ed0b2d47be3c16c36a8e81c224c7ffaa310c6558fb3f932b05',
      role: 'aux'
    },
    tokenizer('merges.txt'),
    {
      file: 'model.safetensors-00001-of-00004.safetensors',
      sizeBytes: 5276436216,
      sha256: '862bf7bba8a50145d19d0ae463931fae515284024736592a73a336bc4dfa54ee',
      role: 'aux'
    },
    {
      file: 'model.safetensors-00002-of-00004.safetensors',
      sizeBytes: 5335161576,
      sha256: 'bace8e115e11ca93c22f0352a60d2fb0c76ac6d7d1c2993c143b7ad2b6c8868c',
      role: 'aux'
    },
    {
      file: 'model.safetensors-00003-of-00004.safetensors',
      sizeBytes: 5368717376,
      sha256: '63a021ac0011cbfc66166e77103327a8b45dee95832e36551f6b4c3337448959',
      role: 'aux'
    },
    {
      file: 'model.safetensors-00004-of-00004.safetensors',
      sizeBytes: 3325995704,
      sha256: '1a643bbed669266917b5058b5d3f660c03233599249ff7d8fd083decfe662ae0',
      role: 'aux'
    },
    {
      file: 'model.safetensors.index.json',
      sizeBytes: 79657,
      sha256: '026b9d9fe03f19fd065f2a2f56a332c67640878106c0ca6be2f60c655ed5a8c1',
      role: 'aux'
    },
    tokenizer('tokenizer.json'),
    tokenizer('tokenizer_config.json'),
    tokenizer('vocab.json')
  ]
})

/** Every Kev release the app offers. */
export const KEV_MODELS: readonly ModelEntry[] = [KEV_4B, KEV_9B]

export function isKevModel(modelId: string | null | undefined): boolean {
  return KEV_MODELS.some((model) => model.id === modelId)
}

/** The folder a Kev release's files live under, e.g. "kev-4b". */
function kevFolder(model: ModelEntry): string {
  return model.files[0]!.name.split('/')[0]!
}

export interface KevRuntimeArtifact {
  checkpoint: string
  base: string
  python: string
  script: string
}

/** The weight shards a SafeTensors index names. Empty when the index is missing or unreadable. */
function indexedShards(base: string): string[] {
  try {
    const index = JSON.parse(
      fs.readFileSync(path.join(base, 'model.safetensors.index.json'), 'utf8')
    ) as { weight_map?: Record<string, string> }
    return [...new Set(Object.values(index.weight_map ?? {}))]
  } catch {
    return []
  }
}

interface KevRuntimeParts {
  checkpoint: string
  base: string
  python: string | undefined
  script: string | undefined
  /** Every checkpoint and base file the server reads is on disk. */
  modelReady: boolean
}

function resolveKevRuntimeParts(modelId: string): KevRuntimeParts | null {
  if (!(
    (process.platform === 'darwin' && process.arch === 'arm64') ||
    process.platform === 'win32' ||
    (process.platform === 'linux' && process.arch === 'x64')
  )) {
    return null
  }
  const model = KEV_MODELS.find((entry) => entry.id === modelId)
  if (!model) return null
  const folder = kevFolder(model)
  const modelRoot = path.join(llm.getModelsDir(), folder)
  const checkpoint = path.join(modelRoot, 'checkpoint-v1.0') + path.sep
  // Only 4B ever had a pre-catalog base outside the models folder.
  const base =
    (model.id === KEV_4B_ID ? reusableKevBaseDir(llm.getModelsDir()) : null) ??
    path.join(modelRoot, 'base')
  const pythonRelative =
    process.platform === 'win32'
      ? path.join('kev-runtime', 'python', 'python.exe')
      : path.join('kev-runtime', 'python', 'bin', 'python3')
  // The runtime downloaded with the model comes first; resources/bin keeps serving
  // development checkouts and the platforms that still bundle it.
  const installedRoot = installedKevRuntimeRoot()
  const packagedPython = [...(installedRoot ? [installedRoot] : []), ...binRoots()]
    .map((directory) => path.join(directory, pythonRelative))
    .find((candidate) => fs.existsSync(candidate))
  const legacyPython = path.join(
    path.dirname(llm.getModelsDir()),
    'decision-models',
    'kev-source',
    '.venv',
    'bin',
    'python'
  )
  const python = packagedPython ?? (fs.existsSync(legacyPython) ? legacyPython : undefined)
  const script = binRoots()
    .map((directory) => path.join(directory, 'kev-local-server.py'))
    .find((candidate) => fs.existsSync(candidate))
  // The index names the shards: 4B has two, 9B four. A base missing any shard is incomplete.
  const shards = indexedShards(base)
  const required = [
    path.join(checkpoint, 'head.pt'),
    path.join(checkpoint, 'adapter_model.safetensors'),
    path.join(base, 'config.json'),
    path.join(base, 'model.safetensors.index.json'),
    ...shards.map((shard) => path.join(base, shard)),
    path.join(base, 'tokenizer.json'),
    path.join(base, 'tokenizer_config.json')
  ]
  const modelReady =
    shards.length > 0 &&
    required.every((file) => fileSizeOf(path.dirname(file), path.basename(file)) > 0)
  return { checkpoint, base, python, script, modelReady }
}

/** Resolve the server runtime and the model downloaded from the Models screen. */
export function resolveKevRuntimeArtifact(modelId: string = KEV_4B_ID): KevRuntimeArtifact | null {
  const parts = resolveKevRuntimeParts(modelId)
  return parts?.modelReady && parts.python && parts.script
    ? { checkpoint: parts.checkpoint, base: parts.base, python: parts.python, script: parts.script }
    : null
}

/** The runtime archive a Kev model still needs on this machine, or null when it has one
 *  (downloaded, bundled, or the legacy source checkout) or this platform bundles its own. */
export function kevRuntimeToDownload(
  modelId: string = KEV_4B_ID
): ReturnType<typeof kevRuntimeAsset> {
  const asset = kevRuntimeAsset()
  if (!asset || !isKevModel(modelId)) return null
  return resolveKevRuntimeParts(modelId)?.python ? null : asset
}

/** The model is on disk but its runtime is not: an install from before the runtime moved
 *  out of the Mac app. Starting Kev fetches the runtime first. */
export function kevNeedsOnlyRuntime(modelId: string): boolean {
  const parts = resolveKevRuntimeParts(modelId)
  return Boolean(parts?.modelReady && kevRuntimeToDownload(modelId))
}

const DESKTOP_CATALOG = [BONSAI_2, BONSAI_2_9B, DECIDER_2B, DECIDER_2B_VISION, ...KEV_MODELS]
const DESKTOP_CATALOG_IDS = new Set(DESKTOP_CATALOG.map((model) => model.id))

/** The shared catalog with the fetched entries merged in, without the desktop-only ids. */
function baseCatalog(): ModelEntry[] {
  return baseCatalogModels().filter((model) => !DESKTOP_CATALOG_IDS.has(model.id))
}

/** The desktop-only entries, each replaced by a fetched entry with the same id. */
function desktopEntries(): ModelEntry[] {
  const fetched = new Map(remoteCatalogModels().map((model) => [model.id, model]))
  return DESKTOP_CATALOG.map((model) => fetched.get(model.id) ?? model)
}

export async function desktopCatalog(): Promise<ModelEntry[]> {
  const catalog = baseCatalog().map((model) => {
    const companion = Object.entries(MTP_COMPANIONS).find(([id]) => id === model.id)?.[1]
    const files =
      companion && !model.files.some((file) => file.name === companion.name)
        ? [...model.files, companion]
        : model.files
    return {
      ...model,
      files,
      ...(model.grounder ? { tags: [...new Set(['Specialist', ...(model.tags ?? [])])] } : {})
    }
  })
  const uiMate = catalog.find((model) => model.id === 'bartowski/tencent_UI-Mate-9B-GGUF')
  const uiMateMtp = uiMate
    ? [
        {
          ...uiMate,
          id: `${uiMate.id}+MTP`,
          name: `${uiMate.name} MTP`,
          availability: 'coming_soon' as const,
          availabilityNote:
            'The separate UI-Mate MTP download is not yet verified. Installed models with built-in MTP heads remain supported.',
          description:
            'UI-Mate trained weights with a matching Qwen3.5 9B MTP draft. Includes the main model, vision projector, and prediction weights.',
          files: [...uiMate.files, MTP_COMPANIONS['bartowski/tencent_UI-Mate-9B-GGUF+MTP']]
        }
      ]
    : []
  return [...desktopEntries(), ...catalog, ...uiMateMtp]
}

/** Free bytes on the volume that holds `dir`, or null when the OS will not say. */
function freeBytes(dir: string): number | null {
  try {
    const stats = fs.statfsSync(dir)
    return stats.bavail * stats.bsize
  } catch {
    return null
  }
}

export interface DownloadProgress {
  modelId: string
  /** The name a person reads for `modelId`. Screens show this, never the id. */
  modelName: string
  percent?: number
  status?: 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled'
  currentFile?: string
  /** Which file of the job is in flight, 1-based, and how many the job has. percent/downloadedMB
   *  measure the WHOLE job, so these exist to say what the named file is a part of. */
  fileIndex?: number
  fileCount?: number
  downloadedMB?: string
  totalMB?: string
  downloadedBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
  error?: string
  /** On completion: the exact installed package to activate (an alternate size of a catalog model
   *  is its own package), so a switch loads the size that was downloaded. */
  installedId?: string
}
export type ProgressCb = (p: DownloadProgress) => void

const downloadQueue = modelDownloadQueue
const lastProgress = new Map<string, DownloadProgress>()

export { DOWNLOAD_INTERRUPTED_ERROR, shutdownModelDownloads }

function activeModelFile(): string {
  return path.join(llm.getModelsDir(), 'active-model.json')
}

const KEV_BASE_PREFIX = 'kev-4b/base/'
export const KEV_CHECKPOINT_PREFIX = 'kev-4b/checkpoint-v1.0/'
const KEV_BASE_FILE_SIZES = new Map(
  KEV_4B.files
    .filter((file) => file.name.startsWith(KEV_BASE_PREFIX))
    .map((file) => [file.name.slice(KEV_BASE_PREFIX.length), file.sizeBytes ?? 0])
)

function directoryHasExpectedFiles(directory: string, files: ReadonlyMap<string, number>): boolean {
  for (const [name, size] of files) {
    try {
      if (fs.statSync(path.join(directory, name)).size !== size) return false
    } catch {
      return false
    }
  }
  return true
}

/** A pre-catalog Kev install used this directory. Reuse its Qwen base instead of
 * downloading a second 9.34 GB copy. GGUF chat weights are not compatible: Kev
 * needs the original SafeTensors tensors for its LoRA merge.
 * Check the profile location too because the models folder can move. */
function reusableKevBaseDir(modelsDirectory: string): string | null {
  const candidates = [
    path.join(path.dirname(modelsDirectory), 'decision-models', 'qwen3.5-4b-base'),
    path.join(dataDir(), 'decision-models', 'qwen3.5-4b-base')
  ]
  return (
    candidates.find((candidate) => directoryHasExpectedFiles(candidate, KEV_BASE_FILE_SIZES)) ??
    null
  )
}

function modelFilePath(dir: string, name: string): string {
  if (path.isAbsolute(name)) return resolveModelReference(name)
  const managed = resolveModelAsset(name, [dir])
  if (managed) return managed
  if (name.startsWith(KEV_BASE_PREFIX)) {
    const reusableBase = reusableKevBaseDir(dir)
    if (reusableBase) return path.join(reusableBase, name.slice(KEV_BASE_PREFIX.length))
  }
  return resolveModelReference(name, [dir, ...modelReadDirectories()])
}

/** Size (bytes) of a file in the models dir; 0 when absent/unreadable. The single
 *  FS probe injected into the pure catalog logic. */
function fileSizeOf(dir: string, name: string): number {
  try {
    return fs.statSync(modelFilePath(dir, name)).size
  } catch {
    return 0
  }
}

/** Use the downloader's disk probe to count only files this job must fetch. */
export function remainingModelDownloadBytes(entry: Pick<CatalogEntry, 'files'>): number {
  const dir = llm.getModelsDir()
  return remainingDownloadBytes(entry, (name) => fileSizeOf(dir, name))
}

function downloadedPrimary(model: DownloadedModel): string | undefined {
  return model.files.find((name) => !isProjectorFileName(name)) ?? model.files[0]
}

function downloadedProjector(model: DownloadedModel): string | undefined {
  return model.files.find(isProjectorFileName)
}

/** Exact id first; a unique family match keeps a stale pre-migration selection working. */
function downloadedVariant(models: DownloadedModel[], id: string): DownloadedModel | undefined {
  const exact = models.find((model) => model.id === id)
  if (exact) return exact
  const family = models.filter((model) => model.familyId === id)
  return family.length === 1 ? family[0] : undefined
}

/** Bytes a download of `model` still needs, and which of its files are already on disk (a shared
 *  encoder or VAE another model brought), when some are. */
function missingBytes(
  model: CatalogEntry,
  dir: string
): { missingBytes?: number; onDiskFiles?: string[] } {
  const files = model.files as { name: string; sizeBytes?: number }[]
  const onDisk = files.filter((file) => fileSizeOf(dir, file.name) > 0)
  if (onDisk.length === 0 || onDisk.length === files.length) return {}
  return {
    missingBytes: files
      .filter((file) => !onDisk.includes(file))
      .reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0),
    onDiskFiles: onDisk.map((file) => file.name)
  }
}

export async function getCatalog(): Promise<{
  kinds: readonly string[]
  memoryGb: number
  models: unknown[]
}> {
  const { MODEL_KINDS } = await import('@offgrid/models')
  const CATALOG = await desktopCatalog()
  const dir = llm.getModelsDir()
  // Merge the three model sources (imported locals, tagged "Imported"; free-form
  // HF downloads whose files are all present, tagged "Downloaded"; then the
  // catalog) in that exact order - decision in catalog-logic, filesystem probe
  // injected as a closure so it stays pure.
  const present = (name: string): boolean => fileSizeOf(dir, name) > 0
  const downloaded = reconcileDownloadedModelRegistry(dir, CATALOG as unknown as CatalogEntry[])
  const locals = getLocalModels()
  const models = mergeCatalog({
    locals,
    downloaded,
    installedDownloadedIds: installedDownloadedIds(dir),
    catalog: CATALOG as unknown as CatalogEntry[],
    present,
    sizeOf: (name) => fileSizeOf(dir, name)
  })
  const servers = getRemoteVisionServerSettings().servers
  const remoteModels = remoteVisionInventoryModels(servers)
  // A model whose runtime is not on this machine is not offered for download: Kev without its
  // runtime, Parakeet without sherpa-onnx. One already downloaded stays listed, so it can be
  // deleted.
  const { kevRuntimeInstalled, parakeetRuntimeInstalled } = await import('./runtime-availability')
  const kev = kevRuntimeInstalled()
  const parakeet = parakeetRuntimeInstalled()
  const offered = models.filter((entry) => {
    const model = entry as { id?: string; engine?: string; files?: { name: string }[] }
    const runtimeMissing =
      (!kev && isKevModel(model.id)) || (!parakeet && model.engine === 'parakeet')
    if (!runtimeMissing) return true
    const files = model.files ?? []
    return files.length > 0 && files.every((file) => present(file.name))
  })
  // Every row is named by the one shared resolver, so no screen ever shows a file or repo id.
  const sources: ModelNameSources = {
    catalog: CATALOG,
    downloaded,
    locals,
    remote: remoteNameSources(servers)
  }
  // Tool calling and a thinking control are chat traits the catalog does not record: they live in
  // the model's GGUF chat template. Read them for an installed chat model (the only kind the pickers
  // list). One file at a time, so a first read holds one template window in memory, not one per
  // model; cached afterwards. Unknown (not installed, no template) stays undefined: no icon.
  const traitsById = new Map<string, { tools?: boolean; reasoning?: boolean }>()
  for (const model of offered as CatalogEntry[]) {
    if (model.kind !== 'text' && model.kind !== 'vision') continue
    const name = primaryFileName(model)
    if (!name || fileSizeOf(dir, name) <= 0) continue
    const traits = await readGgufTemplateTraits(modelFilePath(dir, name))
    if (traits) traitsById.set(model.id, traits)
  }
  return {
    kinds: [...MODEL_KINDS, 'embedding'],
    // This machine's memory, as the Models screen judges "too big for this Mac" (a model's
    // minRamGb), so a paired phone can judge which models this computer can take.
    memoryGb: Math.round(totalmem() / 1e9),
    models: [
      ...offered.map((model) => ({
        ...model,
        ...traitsById.get((model as CatalogEntry).id),
        // What a download would still fetch: files another model already brought (a shared text
        // encoder or VAE) are on disk and cost nothing. Absent when nothing is on disk yet.
        ...missingBytes(model as CatalogEntry, dir)
      })),
      ...remoteModels
    ].map((model) => ({
      ...model,
      name: describeModel(model.id, sources).displayName
    }))
  }
}

function remoteNameSources(
  servers: ReturnType<typeof getRemoteVisionServerSettings>['servers']
): NonNullable<ModelNameSources['remote']> {
  return servers.map((server) => ({ serverId: server.id, models: server.modelCatalog ?? [] }))
}

let nameSourcesCache: { version: number; at: number; sources: ModelNameSources } | null = null

/** What the shared name resolver matches a model reference against: the desktop catalog, the
 * download and import registries, and each remote server's advertised models. Cached briefly:
 * listing imported models walks the disk. */
export function modelNameSources(): ModelNameSources {
  const version = settingsVersion()
  const now = Date.now()
  if (nameSourcesCache && nameSourcesCache.version === version && now - nameSourcesCache.at < 3_000)
    return nameSourcesCache.sources
  const read = <T>(load: () => T[]): T[] => {
    try {
      return load()
    } catch {
      return []
    }
  }
  const sources: ModelNameSources = {
    catalog: DESKTOP_CATALOG,
    downloaded: read(() => readDownloaded(llm.getModelsDir())),
    locals: read(() => getLocalModels()),
    remote: read(() => [...remoteNameSources(getRemoteVisionServerSettings().servers)])
  }
  nameSourcesCache = { version, at: now, sources }
  return sources
}

/** The name a person reads for any model reference: an id, a file name, a path or a remote id. */
export function displayModelName(ref: string | null | undefined): string | null {
  return modelDisplayName(ref, modelNameSources())
}

export interface ModelIdentity {
  modelId: string
  modelName: string
}

/** Resolve a captured model ID to its display name without consulting which
 * model is active now. Task runs use this once, then persist the result. */
export async function resolveModelIdentity(modelId: string): Promise<ModelIdentity> {
  return { modelId, modelName: displayModelName(modelId) ?? modelId }
}

/** Per-model optional companion status, keyed by id. The renderer uses this to repair
 *  a missing vision projector or DFlash draft without downloading primary weights again. */
export async function getVisionStatuses(): Promise<Record<string, VisionStatus>> {
  const CATALOG = await desktopCatalog()
  const dir = llm.getModelsDir()
  const present = (name: string): boolean => {
    const mtp = Object.values(MTP_COMPANIONS).find((file) => file.name === name)
    return mtp
      ? readGgufMtpSupport(modelFilePath(dir, name), fs, undefined, mtp.sizeBytes)
      : fileSizeOf(dir, name) > 0
  }
  const downloaded = reconcileDownloadedModelRegistry(dir, CATALOG as unknown as CatalogEntry[])
  const merged = mergeCatalog({
    locals: getLocalModels(),
    downloaded,
    installedDownloadedIds: installedDownloadedIds(dir),
    catalog: CATALOG as unknown as CatalogEntry[],
    present
  }) as CatalogEntry[]
  const out: Record<string, VisionStatus> = {}
  for (const m of merged) {
    const st = visionStatus(m, present)
    const primary = modelFilePath(dir, primaryFileName(m) ?? '')
    const companion = Object.entries(MTP_COMPANIONS).find(
      ([id]) => id === m.id || id === m.sourceModelId
    )?.[1]
    if (companion) {
      st.mtpInstalled = readGgufMtpSupport(
        resolveModelReference(companion.name, [path.dirname(primary)]),
        fs,
        undefined,
        companion.sizeBytes
      )
    }
    if (readGgufMtpSupport(primary, fs)) {
      st.supportsMtp = true
      st.mtpInstalled = true
    }
    if (st.supportsVision || st.supportsDflash || st.supportsMtp) {
      out[m.id] = st
    }
  }
  return out
}

/** Catalog ids (plus imported local ids) whose files are fully present on disk. */
export async function listInstalled(): Promise<string[]> {
  const CATALOG = await desktopCatalog()
  const { isMfluxModelCached } = await import('./mflux')
  const dir = llm.getModelsDir()
  const downloaded = reconcileDownloadedModelRegistry(dir, CATALOG as unknown as CatalogEntry[])
  const localInstalled = installedIds({
    locals: getLocalModels(),
    installedDownloadedIds: installedDownloadedIds(dir),
    downloaded,
    catalog: CATALOG as unknown as CatalogEntry[],
    present: (name) => fileSizeOf(dir, name) > 0,
    mfluxCached: (id) => isMfluxModelCached(id)
  })
  const remoteInstalled = remoteVisionInventoryModels(getRemoteVisionServerSettings().servers).map(
    (model) => model.id
  )
  return [...localInstalled, ...remoteInstalled]
}

export interface ComputerUseModelArtifact {
  id: string
  primaryPath: string
  projectorPath?: string
}

/** Resolve one installed Decision artifact without changing active-model.json or the Chat runtime. */
export async function resolveComputerUseModelArtifact(
  modelId: string
): Promise<ComputerUseModelArtifact | null> {
  const catalog = (await desktopCatalog()) as unknown as CatalogEntry[]
  const directory = llm.getModelsDir()
  const entry = catalog.find((candidate) => candidate.id === modelId)
  if (entry && entry.kind === 'computer_use') {
    const primary = primaryFileName(entry)
    const projector = entry.files.find((file) => file.role === 'mmproj')?.name
    if (
      primary &&
      fileSizeOf(directory, primary) > 0 &&
      (!projector || fileSizeOf(directory, projector) > 0)
    ) {
      return {
        id: modelId,
        primaryPath: modelFilePath(directory, primary),
        ...(projector ? { projectorPath: modelFilePath(directory, projector) } : {})
      }
    }
  }
  const downloaded = downloadedVariant(
    reconcileDownloadedModelRegistry(directory, catalog),
    modelId
  )
  if (!downloaded || downloaded.kind !== 'computer_use') return null
  const primary = downloadedPrimary(downloaded)
  const projector = downloadedProjector(downloaded)
  if (!primary || fileSizeOf(directory, primary) <= 0) return null
  return {
    id: downloaded.id,
    primaryPath: modelFilePath(directory, primary),
    ...(projector && fileSizeOf(directory, projector) > 0
      ? { projectorPath: modelFilePath(directory, projector) }
      : {})
  }
}

export async function searchModels(query: string, kind?: string): Promise<unknown[]> {
  try {
    if (kind === 'embedding') {
      const { searchEmbeddingModels } = await import('./embedding-hub')
      return await searchEmbeddingModels(query)
    }
    const { searchHuggingFace } = await import('@offgrid/models')
    return await searchHuggingFace(query, { limit: 30, kind: kind as never })
  } catch (err) {
    console.error('[models] HF search failed:', err)
    return []
  }
}

export async function getModelFiles(
  modelId: string
): Promise<import('@offgrid/models').ModelFileVariant[]> {
  const { getModelFiles: listFiles } = await import('@offgrid/models')
  const repo = modelId === 'bartowski/tencent_UI-Mate-9B-GGUF+MTP' ? modelId.slice(0, -4) : modelId
  return (await listFiles(repo)).filter(
    (file) => !/^(?:mtp[-_.])|[-_.]mtp[-_.]only[-_.]/i.test(file.fileName)
  )
}

/** Record a download that runs outside this module (a search model) in the shared registry. */
export function recordDownloadProgress(p: DownloadProgress): void {
  ensureRegistryLoaded()
  lastProgress.set(p.modelId, p)
  if (p.status && p.status !== 'queued' && p.status !== 'downloading') persistRegistry()
}

export function downloadStatus(modelId: string): DownloadProgress | null {
  return lastProgress.get(modelId) ?? null
}

export function cancelDownload(modelId: string): boolean {
  const cancelled = downloadQueue.cancel(modelId)
  writeDiagnosticLog('models.download', 'cancel.requested', { modelId, cancelled })
  return cancelled
}

/** A download refused before it ever reached the queue is still an OUTCOME the watchers must see.
 *  The refusal used to be returned to the caller only, so the status registry kept whatever the UI
 *  had assumed and the card sat on a spinner forever. Publishing 'failed' the same way a mid-transfer
 *  failure does means every client — the screen, a headless poller, the registry — learns the same
 *  thing from one place, whether the download died at byte zero or at the last one. */
function publishRefusal(
  modelId: string,
  error: string,
  onProgress?: ProgressCb
): { success: false; error: string } {
  const p: DownloadProgress = {
    modelId,
    modelName: displayModelName(modelId) ?? modelId,
    status: 'failed',
    percent: 0,
    error
  }
  lastProgress.set(modelId, p)
  onProgress?.(p)
  return { success: false, error }
}

async function installKevRuntimeInJob(
  modelId: string,
  asset: NonNullable<ReturnType<typeof kevRuntimeAsset>>,
  signal: AbortSignal,
  onBytes: (downloadedBytes: number) => void
): Promise<void> {
  writeDiagnosticLog('models.download', 'kev-runtime.started', { modelId, version: asset.version })
  await installKevRuntime(asset, { signal, onBytes })
  writeDiagnosticLog('models.download', 'kev-runtime.completed', {
    modelId,
    version: asset.version
  })
}

/** Download a catalog entry or any Hugging Face repo id. Progress via callback
 *  AND a status registry (so a headless poller can read it). */
export async function downloadModel(
  modelId: string,
  onProgress?: ProgressCb,
  fileName?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    return await withStorageDownload(() => downloadModelInner(modelId, onProgress, fileName))
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function downloadModelInner(
  modelId: string,
  onProgress?: ProgressCb,
  fileName?: string
): Promise<{ success: boolean; error?: string }> {
  if (!downloadQueue.isAccepting()) {
    writeDiagnosticLog('models.download', 'request.rejected', {
      modelId,
      reason: 'application_shutdown'
    })
    return publishRefusal(modelId, DOWNLOAD_INTERRUPTED_ERROR, onProgress)
  }
  // A search (embedding) model: its own files and cache folder, the same queue and registry.
  const embedding = await import('./embedding-setup-download')
  if (embedding.isEmbeddingDownloadId(modelId)) {
    const storageError = modelStorageError()
    if (storageError) return publishRefusal(modelId, storageError, onProgress)
    return embedding.queueEmbeddingDownload(modelId, (p) => {
      recordDownloadProgress(p)
      onProgress?.(p)
    })
  }
  const { resolveHuggingFaceModel } = await import('@offgrid/models')
  const CATALOG = await desktopCatalog()
  const inCatalog = CATALOG.find((m) => m.id === modelId)
  let entry = inCatalog ?? (await resolveHuggingFaceModel(modelId))
  if (fileName && entry?.kind === 'video') {
    // The selected weights determine the encoder and VAE. Replacing only the
    // primary file can pair a Wan 2.2 variant with a Wan 2.1 default's VAE.
    const selectedPack = await resolveHuggingFaceModel(modelId, { kind: 'video', fileName })
    if (!selectedPack)
      return publishRefusal(
        modelId,
        'Selected video model file is no longer available.',
        onProgress
      )
    entry = { ...entry, files: selectedPack.files, minRamGb: selectedPack.minRamGb }
  } else if (fileName && entry) {
    const variants = await getModelFiles(modelId)
    const variant = variants.find((file) => file.fileName === fileName)
    if (!variant)
      return publishRefusal(modelId, 'Selected model file is no longer available.', onProgress)
    let parts: typeof variants
    try {
      parts = selectedGgufParts(variants, fileName)
    } catch (error) {
      return publishRefusal(modelId, (error as Error).message, onProgress)
    }
    const catalogAuxFiles = entry.files.filter(
      (file) =>
        file.role !== 'primary' &&
        file.role !== 'mmproj' &&
        !/-\d{5}-of-\d{5}\.gguf$/i.test(file.name)
    )
    const projectorFiles = variant.mmproj
      ? [
          {
            name: variant.mmproj.fileName,
            url: variant.mmproj.url,
            sizeBytes: variant.mmproj.sizeBytes,
            role: 'mmproj' as const
          }
        ]
      : (inCatalog?.files.filter((file) => file.role === 'mmproj') ?? [])
    entry = {
      ...entry,
      files: [
        ...parts.map((part, index) => ({
          name: part.fileName,
          url: part.downloadUrl,
          sizeBytes: part.sizeBytes,
          sha256:
            inCatalog?.files.find((file) => file.name === part.fileName)?.sha256 ?? part.sha256,
          role: index === 0 ? ('primary' as const) : ('aux' as const)
        })),
        ...projectorFiles,
        ...catalogAuxFiles.filter((file) => !parts.some((part) => part.fileName === file.name))
      ]
    }
  }
  // Full MTP exports often reuse the standard export's filename. Keep their
  // weights distinct and record the actual local filename in the existing registry.
  if (entry && /-MTP-GGUF$/i.test(modelId)) {
    entry = {
      ...entry,
      files: entry.files.map((file) =>
        file.role === 'primary'
          ? { ...file, name: file.name.replace(/\.gguf$/i, '+MTP.gguf') }
          : file
      )
    }
  }
  // One tap brings everything the model needs. A catalog entry lists its MTP head already; a file
  // picked from Hugging Face gets its separately published head in the same job.
  if (entry && !inCatalog) {
    const primary = primaryFileName(entry)
    const head = primary ? mtpHeadForPrimaryFile(primary) : undefined
    if (head && !entry.files.some((file) => file.name === head.name))
      entry = { ...entry, files: [...entry.files, { ...head, role: 'aux' as const }] }
  }
  if (!entry) {
    writeDiagnosticLog('models.download', 'request.rejected', { modelId, reason: 'unknown_model' })
    return publishRefusal(modelId, 'unknown model', onProgress)
  }
  // A free-form repo resolves to the chat default; its files decide whether it is an image model.
  // The registry is re-judged on every read, so it records the resolved kind, not this guess.
  const resolvedKind = entry.kind
  if (!inCatalog) {
    entry = {
      ...entry,
      kind: downloadedModelKind(
        entry.kind,
        entry.files.map((file) => file.name)
      )
    }
  }
  if (inCatalog?.availability === 'coming_soon') {
    const error = inCatalog.availabilityNote ?? 'This model is coming soon.'
    writeDiagnosticLog('models.download', 'request.rejected', {
      modelId,
      reason: 'runtime_adapter_unavailable'
    })
    return publishRefusal(modelId, error, onProgress)
  }
  writeDiagnosticLog('models.download', 'request.accepted', {
    modelId,
    kind: entry.kind,
    files: entry.files.length
  })

  const dir = llm.getModelsDir()
  const storageError = modelStorageError()
  if (storageError) return publishRefusal(modelId, storageError, onProgress)
  fs.mkdirSync(dir, { recursive: true })
  ensureRegistryLoaded()
  // Re-entrancy guard (before any status emit / queue registration): a second
  // download of the same id would write into the SAME .part (interleaved writes →
  // corrupt file). The queue tracks both waiting and active ids, so double-clicking
  // a queued card cannot enqueue it twice either.
  if (downloadQueue.has(modelId)) {
    writeDiagnosticLog('models.download', 'request.rejected', {
      modelId,
      reason: 'already_downloading'
    })
    return { success: false, error: 'already downloading' }
  }
  let loggedStatus: DownloadProgress['status'] | undefined
  const modelName = displayModelName(modelId) ?? modelId
  const send = (data: Partial<DownloadProgress>): void => {
    const p: DownloadProgress = { ...lastProgress.get(modelId), modelId, modelName, ...data }
    lastProgress.set(modelId, p)
    onProgress?.(p)
    if (p.status && p.status !== loggedStatus) {
      loggedStatus = p.status
      reportDownloadStatus(modelId, p, () => freeBytes(dir) ?? undefined, entry.kind)
      writeDiagnosticLog(
        'models.download',
        `status.${p.status}`,
        { modelId, error: p.error, percent: p.percent },
        p.status === 'failed' ? 'error' : 'info'
      )
    }
    // Queue/start persistence happens in the lifecycle callback below. Persist
    // terminal transitions here, but skip high-frequency transfer ticks.
    if (p.status && p.status !== 'queued' && p.status !== 'downloading') persistRegistry()
  }
  // A cancelled download keeps its partial file, so downloading the model again resumes where it
  // stopped. Temporary Storage in the Storage tab clears it.
  const interruptedResult = (signal: AbortSignal): { success: false; error: string } => {
    const interrupted = signal.reason === DOWNLOAD_INTERRUPTED_ERROR
    const error = interrupted ? DOWNLOAD_INTERRUPTED_ERROR : 'cancelled'
    send(interrupted ? { status: 'failed', error } : { status: 'cancelled' })
    return { success: false, error }
  }
  return downloadQueue.enqueue(
    modelId,
    async (signal) => {
      if (entry.runtime === 'mflux') {
        try {
          const { downloadMfluxModel } = await import('./mflux')
          await downloadMfluxModel(modelId, (pct: number) =>
            send({ percent: pct, status: 'downloading' })
          )
          settingsChanged()
          send({ percent: 100, status: 'completed' })
          return { success: true }
        } catch (err) {
          const error = downloadFailureMessage(err)
          send({ status: 'failed', error })
          return { success: false, error }
        }
      }

      let activePartPath: string | null = null
      let activePartRecoverable = true
      try {
        // Decide the JOB before reporting on it. A model is several files, and percent used to be
        // per-file: a two-file download ran 0→100 for the weights and then 0→100 again for the
        // projector, so the number reset halfway and meant something different each time. The job
        // is the set of files this run must actually fetch (a file already on disk is not work),
        // and one percent measures the whole of it.
        const pending = entry.files.filter((file) => {
          const mtp = Object.values(MTP_COMPANIONS).find(
            (companion) => companion.name === file.name
          )
          const nativeUiMate =
            modelId === 'bartowski/tencent_UI-Mate-9B-GGUF+MTP' &&
            readGgufMtpSupport(path.join(dir, primaryFileName(entry) ?? ''), fs)
          const present = mtp
            ? nativeUiMate ||
              readGgufMtpSupport(path.join(dir, file.name), fs, undefined, mtp.sizeBytes)
            : fileSizeOf(dir, file.name) > 0
          if (present) {
            writeDiagnosticLog('models.download', 'file.skipped', {
              modelId,
              file: file.name,
              reason: 'already_present'
            })
          }
          return !present
        })
        // Catalog sizes plan the denominator; the file being fetched contributes its REAL
        // content-length instead, so the total sharpens as the job proceeds rather than drifting.
        // A Kev model on a Mac also needs its Python runtime; it rides in the same job, so one
        // progress bar covers the weights and the runtime.
        const kevRuntime = kevRuntimeToDownload(modelId)
        const plannedBytes = [
          ...pending.map((file) => file.sizeBytes ?? 0),
          ...(kevRuntime ? [kevRuntime.bytes] : [])
        ]
        const fileCount = plannedBytes.length
        const laterBytes = (index: number): number =>
          plannedBytes.slice(index + 1).reduce((sum, bytes) => sum + bytes, 0)
        let jobDoneBytes = 0
        let rateSample: ProgressRateSample | undefined
        const reportTransfer = (
          currentFile: string,
          fileIndex: number,
          written: number,
          total: number
        ): void => {
          const jobDone = jobDoneBytes + written
          const jobTotal = jobDoneBytes + total + laterBytes(fileIndex)
          const rate = sampleProgressRate(rateSample, {
            currentBytes: jobDone,
            sampledAtMs: Date.now()
          })
          rateSample = rate.sample
          send({
            currentFile,
            fileIndex: fileIndex + 1,
            fileCount,
            percent: jobTotal ? Math.round((jobDone / jobTotal) * 100) : 0,
            downloadedMB: (jobDone / 1048576).toFixed(1),
            totalMB: jobTotal ? (jobTotal / 1048576).toFixed(1) : '?',
            downloadedBytes: jobDone,
            totalBytes: jobTotal || undefined,
            bytesPerSecond: rate.bytesPerSecond,
            status: 'downloading'
          })
        }
        for (const [fileIndex, file] of pending.entries()) {
          const dest = path.join(dir, file.name)
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          const partPath = `${dest}.part`
          activePartPath = partPath
          activePartRecoverable = true
          // Resume from a partial .part if one exists (e.g. download interrupted by a
          // quit/crash) via an HTTP Range request, so we don't re-fetch GBs.
          let resumeFrom = 0
          try {
            if (fs.existsSync(partPath)) resumeFrom = fs.statSync(partPath).size
          } catch {
            /* fresh */
          }
          // A partial file already as long as the whole file (cancelled after the last byte, before
          // it was promoted) has no range left to ask for: a server answers 416 forever. Start over.
          if (file.sizeBytes && resumeFrom >= file.sizeBytes) {
            fs.rmSync(partPath, { force: true })
            resumeFrom = 0
          }
          writeDiagnosticLog('models.download', 'file.started', {
            modelId,
            file: file.name,
            resumeBytes: resumeFrom
          })
          const res = await fetch(file.url, {
            signal,
            headers: resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : undefined
          })
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${file.name}`)
          // Server honored the range (206) → append; otherwise (200) start over.
          const append = resumeFrom > 0 && res.status === 206
          const remaining = Number(res.headers.get('content-length') ?? 0)
          const total = (append ? resumeFrom : 0) + remaining
          // Refuse before writing, in words, when the folder cannot hold this file (the size the
          // server reports): running out halfway wastes the time and bandwidth already spent.
          // A restart (200) rewrites the partial file, so its bytes come back too.
          // A server may omit the length; the catalog's size, less what is already on disk, stands in.
          const needed =
            remaining || Math.max(0, (file.sizeBytes ?? 0) - (append ? resumeFrom : 0))
          const free = freeBytes(dir)
          const reclaimable = append ? 0 : resumeFrom
          if (free !== null && needed > free + reclaimable) {
            void res.body.cancel().catch(() => {})
            throw new Error(
              `Not enough disk space. ${file.name} needs ${(needed / 1e9).toFixed(1)} GB and ${(free / 1e9).toFixed(1)} GB is free.`
            )
          }
          const out = fs.createWriteStream(partPath, append ? { flags: 'a' } : {})
          let written = append ? resumeFrom : 0
          const reader = res.body.getReader()
          // pumpToFile owns the write-stream error path: a disk-full/EIO 'error' becomes
          // a rejection (caught below → status 'failed') instead of crashing the main
          // process, and never hangs on a 'finish' that won't come.
          await pumpToFile(reader, out, (n) => {
            written += n
            reportTransfer(file.name, fileIndex, written, total)
          })
          if (signal.aborted) {
            return interruptedResult(signal)
          }
          // Verify the file is complete + valid BEFORE promoting it — never mark a
          // truncated/corrupt download installed (it loads as a blank "Chat model Down").
          const integrityErr = downloadIntegrityError(file.name, written, total, partPath)
          if (integrityErr) {
            activePartRecoverable = false
            throw new Error(integrityErr)
          }
          // Content check: when the file carries an expected SHA-256 (e.g. HF's lfs
          // oid), verify the bytes match — catches silent corruption the byte-count +
          // magic check can't. Skipped when no hash is known.
          const checksumErr = await sha256IntegrityError(
            file.name,
            partPath,
            (file as { sha256?: string }).sha256
          )
          if (checksumErr) {
            activePartRecoverable = false
            throw new Error(checksumErr)
          }
          fs.renameSync(partPath, dest)
          activePartPath = null
          jobDoneBytes += written // this file's real bytes now count toward the job, not a new 0%
          writeDiagnosticLog('models.download', 'file.completed', {
            modelId,
            file: file.name,
            bytes: written
          })
        }
        if (signal.aborted) return interruptedResult(signal)
        if (kevRuntime) {
          await installKevRuntimeInJob(modelId, kevRuntime, signal, (written) =>
            reportTransfer('Kev runtime', pending.length, written, kevRuntime.bytes)
          )
        }
        // An alternate file from a cataloged repository is a separate installed
        // package. Keep it alongside the catalog default and protect its files.
        const matchesCatalog =
          inCatalog &&
          entry.files.length === inCatalog.files.length &&
          entry.files.every((file) =>
            inCatalog.files.some((catalogFile) => catalogFile.name === file.name)
          )
        let installedId = modelId
        if (inCatalog && !matchesCatalog) {
          const files = entry.files.map((file) => ({
            name: file.name,
            sizeBytes: fileSizeOf(dir, file.name),
            role: file.role === 'mmproj' ? ('projector' as const) : ('primary' as const)
          }))
          const packageIdentity = modelPackageIdentity({
            id: modelId,
            name: entry.name,
            kind: entry.kind,
            source: 'downloaded',
            files: files as [(typeof files)[number], ...typeof files],
            engine: entry.kind === 'text' || entry.kind === 'vision' ? 'llama' : undefined
          })
          installedId = packageIdentity
          recordDownloaded(dir, {
            id: packageIdentity,
            familyId: modelId,
            packageIdentity,
            name: entry.name,
            kind: entry.kind,
            files: entry.files.map((file) => file.name)
          })
        } else if (!inCatalog) {
          recordDownloaded(dir, {
            id: modelId,
            name: entry.name,
            kind: resolvedKind,
            files: entry.files.map((f) => f.name)
          })
        }
        // If this download added the projector for the active chat model, turn its
        // vision on now (main-side, so it works even when no Models screen is open).
        await reconcileActiveModelProjector().catch(() => false)
        settingsChanged()
        send({ percent: 100, status: 'completed', installedId })
        return { success: true }
      } catch (err) {
        // A capacity failure cannot resume until space is reclaimed. A file that failed byte or
        // checksum validation must restart because the stored prefix is not trustworthy. Only a
        // transport interruption keeps its partial file for a Range retry.
        if (activePartPath && (!activePartRecoverable || isStorageCapacityError(err))) {
          try {
            fs.rmSync(activePartPath, { force: true })
          } catch {
            /* retain the original write failure */
          }
        }
        if (signal.aborted || (err as Error).name === 'AbortError') {
          return interruptedResult(signal)
        }
        const error = downloadFailureMessage(err)
        send({ status: 'failed', error })
        return { success: false, error }
      }
    },
    (state) => {
      if (state === 'interrupted') {
        send({ status: 'failed', error: DOWNLOAD_INTERRUPTED_ERROR, percent: 0 })
      } else {
        send({ status: state, percent: 0 })
      }
      if (state === 'queued' || state === 'downloading') persistRegistry()
    }
  )
}

interface DeleteModelResult {
  success: boolean
  error?: string
  freedFiles?: number
}

interface TransferredDeletionContext {
  dir: string
  requestedId: string
  target: DownloadedModel
  downloaded: DownloadedModel[]
  catalog: CatalogEntry[]
}

function retainedTransferredFileNames(context: TransferredDeletionContext): Set<string> {
  const { target, downloaded, catalog, dir } = context
  const retained = new Set<string>()
  catalog.forEach((model) => model.files.forEach((file) => retained.add(file.name)))
  getLocalModels(dir).forEach((model) => {
    retained.add(model.primary)
    if (model.mmproj) retained.add(model.mmproj)
  })
  downloaded
    .filter((model) => model.id !== target.id)
    .forEach((model) => model.files.forEach((name) => retained.add(name)))
  return retained
}

function clearTransferredModelSelections(target: DownloadedModel, requestedId: string): void {
  const activeId = getActiveModel()
  if (activeId === target.id || activeId === requestedId) {
    try {
      fs.rmSync(activeModelFile(), { force: true })
    } catch {
      /* already clear */
    }
    llm.reloadModel()
  }
  const primary = downloadedPrimary(target)
  const modals = getAllActiveModals()
  ;(Object.keys(modals) as Modality[]).forEach((kind) => {
    if (
      modalSelectionMatches(modals[kind], target.id, primary) ||
      modalSelectionMatches(modals[kind], requestedId, primary)
    ) {
      setModal(kind, null)
    }
  })
}

function deleteTransferredModel(context: TransferredDeletionContext): DeleteModelResult {
  const { dir, requestedId, target } = context
  // A projector can be shared by two installed quants. Delete only files that no other installed
  // model owns, then remove this exact package from the registry projection.
  const retainedNames = retainedTransferredFileNames(context)
  let freedFiles = 0
  for (const name of target.files) {
    if (!retainedNames.has(name)) {
      try {
        const filePath = path.join(dir, name)
        if (fs.existsSync(filePath)) {
          fs.rmSync(filePath, { force: true })
          freedFiles++
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : `could not delete ${name}`,
          freedFiles
        }
      }
    }
    try {
      fs.rmSync(path.join(dir, `${name}.part`), { force: true })
    } catch {
      /* the installed package remains authoritative */
    }
  }
  removeDownloaded(dir, target.id)
  clearTransferredModelSelections(target, requestedId)
  return { success: true, freedFiles }
}

/**
 * Remove a model found in another app's folder (LM Studio, an added folder). Its files are still on
 * this disk, so removing it frees that space; they go to the Trash rather than being erased, since
 * the folder belongs to the user or another app. Ollama is the exception: its blobs are shared
 * between tags and tracked by manifests, so deleting one by hand breaks Ollama itself.
 */
async function trashExternalModel(modelId: string, dir: string): Promise<DeleteModelResult> {
  const found = discoverExternalModels(
    undefined,
    undefined,
    dir,
    readModelScanFolders(dataDir())
  ).find((model) => model.id === modelId)
  if (!found) return { success: false, error: 'This model is no longer in that folder.' }
  if (found.source === 'Ollama') {
    return {
      success: false,
      error: `Ollama manages this model. Remove it with: ollama rm ${found.name}`
    }
  }
  const { shell } = await import('electron')
  let freedFiles = 0
  for (const file of [found.primary, found.mmproj].filter((value): value is string =>
    Boolean(value)
  )) {
    await shell.trashItem(file)
    freedFiles++
  }
  if (getActiveModel() === modelId) {
    fs.rmSync(activeModelFile(), { force: true })
    llm.reloadModel()
  }
  return { success: true, freedFiles }
}

/** Files owned by complete runtime-discovered video packs, including copied variants. */
async function installedVideoFileNames(excludeWeight?: string): Promise<Set<string>> {
  const { installedVideoPacks } = await import('./generated-videos/status')
  const { videoPackFiles } = await import('@offgrid/models')
  const names = new Set<string>()
  for (const { name: weight } of installedVideoPacks()) {
    if (weight === excludeWeight) continue
    const pack = videoPackFiles(weight)
    if (pack) Object.values(pack).forEach((name) => names.add(name))
  }
  return names
}

/** Delete a model's files from disk. Clears it as active if it was selected. */
export async function deleteModel(modelId: string): Promise<DeleteModelResult> {
  try {
    return await deleteModelFiles(modelId)
  } finally {
    settingsChanged()
  }
}

async function deleteModelFiles(modelId: string): Promise<DeleteModelResult> {
  if (modelId.startsWith('external:'))
    return { success: false, error: 'External models are read only.' }
  const dir = llm.getModelsDir()
  if (modelId.startsWith('external:')) return trashExternalModel(modelId, dir)
  const embedding = await import('./embedding-setup-download')
  if (embedding.isEmbeddingDownloadId(modelId) || embedding.isInstalledEmbeddingModel(modelId))
    return embedding.deleteEmbeddingModel(modelId)
  // Imported local model: remove its files + registry entry, clear if active.
  if (modelId.startsWith('local:')) {
    const list = getLocalModels()
    const lm = list.find((m) => m.id === modelId)
    if (!lm) return { success: false, error: 'unknown local model' }
    let freedLocal = 0
    for (const name of [lm.primary, lm.mmproj].filter(Boolean) as string[]) {
      try {
        fs.rmSync(path.join(dir, name), { force: true })
        freedLocal++
      } catch {
        /* ignore */
      }
    }
    saveLocalModels(list.filter((m) => m.id !== modelId))
    if (getActiveModel() === modelId) {
      try {
        fs.rmSync(activeModelFile(), { force: true })
      } catch {
        /* ignore */
      }
      llm.reloadModel()
    }
    return { success: true, freedFiles: freedLocal }
  }
  const { resolveHuggingFaceModel } = await import('@offgrid/models')
  const CATALOG = await desktopCatalog()
  const catalog = CATALOG as unknown as CatalogEntry[]
  const downloaded = reconcileDownloadedModelRegistry(dir, catalog)
  const transferred = downloadedVariant(downloaded, modelId)
  if (transferred) {
    return deleteTransferredModel({
      dir,
      requestedId: modelId,
      target: transferred,
      downloaded,
      catalog
    })
  }

  const entry = CATALOG.find((m) => m.id === modelId) ?? (await resolveHuggingFaceModel(modelId))
  if (!entry) return { success: false, error: 'unknown model' }
  if (
    entry.files.some((file) => {
      const external = resolveModelAsset(file.name)
      return external && !resolveModelAsset(file.name, [dir])
    })
  ) {
    return {
      success: false,
      error:
        'This model uses files in another model folder. Remove the folder reference to hide it. Files are kept in place.'
    }
  }
  let freed = 0
  const retainedVideoFiles =
    entry.kind === 'video'
      ? await installedVideoFileNames(primaryFileName(entry as unknown as CatalogEntry))
      : new Set<string>()

  if (entry.runtime === 'mflux') {
    try {
      const mod = await import('./mflux')
      const del = (mod as Record<string, unknown>).deleteMfluxModel
      if (typeof del === 'function') await (del as (id: string) => Promise<void>)(modelId)
    } catch (e) {
      console.warn('[models] mflux delete', e)
    }
  } else {
    for (const f of entry.files) {
      if (retainedVideoFiles.has(f.name)) continue
      try {
        fs.rmSync(path.join(dir, f.name), { force: true })
        freed++
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(path.join(dir, `${f.name}.part`), { force: true })
      } catch {
        /* ignore */
      }
    }
    // Drop it from the downloaded registry too (no-op for a catalog model).
    if (findDownloaded(dir, modelId)) removeDownloaded(dir, modelId)
  }

  // If this was the active chat model, clear the selection so we don't point at gone files.
  if (getActiveModel() === modelId) {
    try {
      fs.rmSync(activeModelFile(), { force: true })
    } catch {
      /* ignore */
    }
    llm.reloadModel()
  }
  // Clear any per-modality selection pointing at it — matching the id AND the
  // primary filename, because image picks are stored by filename (D6: without the
  // filename match, deleting the active image model left a dangling pointer).
  const primaryFile =
    entry.runtime === 'mflux' ? null : primaryFileName(entry as unknown as CatalogEntry)
  const modals = getAllActiveModals()
  ;(Object.keys(modals) as Modality[]).forEach((k) => {
    if (modalSelectionMatches(modals[k], modelId, primaryFile)) setModal(k, null)
  })
  clearTaskRolesFor(modelId)
  return { success: true, freedFiles: freed }
}

type LlamaModelKindGate = (kind: string) => boolean

type LlamaModelFiles = { id: string; primary: string; mmproj: string | null }

/** The files an installed llama.cpp model loads from (file names in the models directory, or an
 *  imported model's own paths), or why it cannot load as `expectedKind`. Changes nothing. */
async function resolveLlamaModelFiles(
  modelId: string,
  acceptsKind: LlamaModelKindGate,
  expectedKind: string
): Promise<{ files: LlamaModelFiles } | { error: string }> {
  // Imported local model: resolve from the local registry (not the catalog).
  if (modelId.startsWith('local:') || modelId.startsWith('external:')) {
    const lm = getLocalModels().find((m) => m.id === modelId)
    if (!lm) return { error: 'unknown local model' }
    if (!acceptsKind(lm.kind)) {
      return { error: `${lm.kind} models are not loadable as ${expectedKind}` }
    }
    return { files: { id: modelId, primary: lm.primary, mmproj: lm.mmproj ?? null } }
  }
  const { resolveHuggingFaceModel } = await import('@offgrid/models')
  const CATALOG = await desktopCatalog()
  const catalogEntry = CATALOG.find((model) => model.id === modelId)
  if (catalogEntry?.availability === 'coming_soon') {
    return { error: catalogEntry.availabilityNote ?? 'This model is coming soon.' }
  }
  const dir = llm.getModelsDir()
  const downloaded = reconcileDownloadedModelRegistry(dir, CATALOG as unknown as CatalogEntry[])
  // An exact catalog pick takes precedence once its files are present. A prior
  // download of another quantization in this family must not override it.
  const catalogReady = catalogEntry?.files.every((file) => fileSizeOf(dir, file.name) > 0)
  // Several downloaded sizes of one family: the newest download is the one meant (the registry keeps
  // download order).
  const transferred = catalogReady
    ? undefined
    : (downloadedVariant(downloaded, modelId) ??
      downloaded.filter((model) => model.familyId === modelId).at(-1))
  if (transferred) {
    if (!acceptsKind(transferred.kind)) {
      return { error: `${transferred.kind} models are not loadable as ${expectedKind}` }
    }
    const primary = downloadedPrimary(transferred)
    if (!primary) return { error: 'transferred model has no primary file' }
    const mmproj = downloadedProjector(transferred) ?? null
    return { files: { id: transferred.id, primary, mmproj } }
  }
  const entry = catalogEntry ?? (await resolveHuggingFaceModel(modelId))
  if (!entry) return { error: 'unknown model' }
  if (!acceptsKind(entry.kind)) {
    return { error: `${entry.kind} models are not loadable as ${expectedKind}` }
  }
  const primary = primaryFileName(entry as unknown as CatalogEntry)
  if (!primary) return { error: 'model has no primary file' }
  const mmproj = entry.files.find((f) => f.role === 'mmproj')?.name ?? null
  return { files: { id: modelId, primary, mmproj } }
}

/** The files an installed chat model (text or vision) loads from, without selecting it. */
export function resolveChatModelFiles(
  modelId: string
): Promise<{ files: LlamaModelFiles } | { error: string }> {
  return resolveLlamaModelFiles(modelId, isChatLoadable, 'the chat LLM')
}

async function setActiveLlamaModel(
  modelId: string,
  acceptsKind: LlamaModelKindGate,
  expectedKind: string,
  runtimeOnly = false
): Promise<{ success: boolean; error?: string }> {
  const resolved = await resolveLlamaModelFiles(modelId, acceptsKind, expectedKind)
  if ('error' in resolved) return { success: false, error: resolved.error }
  if (runtimeOnly) {
    llm.useRuntimeModel(resolved.files)
  } else {
    requireModelStorage()
    fs.writeFileSync(activeModelFile(), JSON.stringify(resolved.files, null, 2))
    llm.restoreSelectedModel()
  }
  return { success: true }
}

/**
 * Load a local chat model a gateway request names (a phone on this Mac's server). It becomes the
 * local chat model, but a person who chose a remote server for chat stays on it: only they move
 * chat between local and remote.
 */
export async function loadLocalChatModelForRequest(
  modelId: string
): Promise<{ success: boolean; error?: string }> {
  const result = await setActiveLlamaModel(modelId, isChatLoadable, 'the chat LLM')
  settingsChanged()
  return result
}

/** Set the chat LLM (text/vision). Writes active-model.json + reloads llama-server. */
export async function setActiveModel(
  modelId: string
): Promise<{ success: boolean; error?: string }> {
  const result = await setActiveLlamaModel(modelId, isChatLoadable, 'the chat LLM')
  if (result.success) setRemoteModelSelected('text', false)
  settingsChanged()
  return result
}

/** Load the selected Computer Use policy into the shared llama.cpp runtime for one supervised run. */
export function loadComputerUseModel(
  modelId: string
): Promise<{ success: boolean; error?: string }> {
  return setActiveLlamaModel(modelId, (kind) => kind === 'computer_use', 'Computer Use', true)
}

export function getActiveModel(): string | null {
  try {
    return JSON.parse(fs.readFileSync(modelMetadataFile('active-model.json'), 'utf-8')).id ?? null
  } catch {
    return null
  }
}

/** Heal a stale active-model.json that predates its model gaining a vision projector.
 *  A model activated BEFORE its catalog entry had an mmproj (e.g. Gemma 4 E2B) stored
 *  `mmproj: null`; once the projector is downloaded, hasVision() still reads that null
 *  and the model stays text-only forever. This re-derives the projector from the
 *  catalog and, if the file is now present on disk, writes it into active-model.json and
 *  reloads — so vision turns on without a manual re-activate. Runs at startup and after
 *  every download completes, independent of which screen (if any) is open. Returns true
 *  when it healed something. */
export async function reconcileActiveModelProjector(): Promise<boolean> {
  let cfg: { id?: string; primary?: string; mmproj?: string | null } | null = null
  try {
    cfg = JSON.parse(fs.readFileSync(modelMetadataFile('active-model.json'), 'utf-8'))
  } catch {
    return false // no active selection yet
  }
  if (typeof cfg !== 'object' || cfg === null) return false
  const CATALOG = await desktopCatalog()
  const dir = llm.getModelsDir()
  const downloaded = reconcileDownloadedModelRegistry(dir, CATALOG as unknown as CatalogEntry[])
  const active = cfg
  const transferred = active.id ? downloadedVariant(downloaded, active.id) : undefined
  if (transferred) {
    const primary = downloadedPrimary(transferred)
    const mmproj = downloadedProjector(transferred)
    if (
      primary &&
      mmproj &&
      fileSizeOf(dir, primary) > 0 &&
      fileSizeOf(dir, mmproj) > 0 &&
      (active.id !== transferred.id || active.primary !== primary || active.mmproj !== mmproj)
    ) {
      fs.writeFileSync(
        activeModelFile(),
        JSON.stringify({ id: transferred.id, primary, mmproj }, null, 2)
      )
      settingsChanged()
      llm.reloadModel()
      return true
    }
  }
  const entry = (CATALOG as unknown as CatalogEntry[]).find((m) => m.id === active.id)
  const projector = projectorToHeal(active, entry, (name) => fileSizeOf(dir, name) > 0)
  if (!projector) {
    return false // already has one / no projector / not downloaded yet — leave as is
  }
  fs.writeFileSync(activeModelFile(), JSON.stringify({ ...cfg, mmproj: projector }, null, 2))
  settingsChanged()
  llm.reloadModel()
  return true
}

/**
 * The active model id for EVERY modality (chat LLM + image/voice/transcription),
 * as catalog/local ids. The single "what's active" truth the UI consults so it
 * can mark any model active without re-deriving per-kind rules. Reuses the
 * per-entry active computation in getStorageInfo (one definition of "active").
 */
export async function getActiveModelIds(): Promise<string[]> {
  const info = await getStorageInfo()
  const settings = getRemoteVisionServerSettings()
  const textOnRemote = Boolean(remoteServerIdFor('text'))
  const activeChatId = getActiveModel()
  // Computer Use models are active by the role Tasks gives them (below), not by a pick of their
  // own: the Models screens then show exactly what Tasks > Computer Use and Web Use will run.
  const localIds = info.models
    .filter(
      (model) =>
        model.active &&
        model.kind !== 'computer_use' &&
        (!textOnRemote || model.id !== activeChatId)
    )
    .map((model) => model.id)
  // Each modality's model, from the server that modality runs on.
  const remoteIds = settings.servers.flatMap((server) =>
    server.enabled === false
      ? []
      : remoteVisionInventoryModels([server])
          .filter((model) => {
            if (model.kind === 'computer_use') return false
            const modality =
              model.kind === 'vision' ? 'text' : model.kind === 'speech' ? 'voice' : model.kind
            return remoteServerIdFor(modality) === server.id
          })
          .map((model) => model.id)
  )
  return [...new Set([...localIds, ...remoteIds, ...(await taskRoleModelIds())])]
}

/**
 * The models Computer Use and Web Use run besides Chat: each one's decision model and grounding
 * specialist, local or remote, by the roles its strategy uses (strategyTaskRoles, the same map
 * the task projection reads). The reasoner is the Chat model, already active as text.
 */
async function taskRoleModelIds(): Promise<string[]> {
  const { selectedGrounderModelId } = await import('./vision/grounder-selection')
  const computer = getComputerUseSettings()
  const web = getWebUseSettings()
  const tasks = [
    { strategy: computer.modelStrategy, decision: computer.decisionModelId },
    { strategy: web.modelStrategy, decision: web.decisionModelId }
  ]
  return tasks.flatMap(({ strategy, decision }) =>
    strategyTaskRoles(strategy).map((role) =>
      role === 'grounding' ? selectedGrounderModelId() : (decision ?? DECIDER_2B.id)
    )
  )
}

/**
 * Make ANY installed model the active one for its type — the single seam the UI
 * calls. Routes by kind internally: text/vision load the chat LLM; image/voice/
 * transcription set that modality's default pick. Callers pass only the id and
 * never branch on kind. Adding a new modality needs zero caller changes.
 */
/**
 * "Use" on a task model, from any Models screen: a grounding specialist is shared by both tasks
 * already; a decision model becomes the decision model of both Web Use and Computer Use. Tasks
 * settings can still give each task its own.
 */
function useForTasks(role: 'decision' | 'grounding', modelId: string): void {
  if (role === 'grounding') {
    setTaskRoleModel('computer_use', 'grounding', modelId)
    return
  }
  // "Use" must enable the role, not only save an unused preference. Keep each
  // task's existing grounding choice and all settings outside its model strategy.
  const computer = getComputerUseSettings()
  setComputerUseSettings({
    ...computer,
    decisionModelId: modelId,
    modelStrategy: strategyTaskRoles(computer.modelStrategy).includes('grounding')
      ? 'decision_plus_specialist'
      : 'decision_plus_reasoning'
  })
  const web = getWebUseSettings()
  setWebUseSettings({
    ...web,
    decisionModelId: modelId,
    modelStrategy: strategyTaskRoles(web.modelStrategy).includes('grounding')
      ? 'decision_plus_specialist'
      : 'decision_plus_reasoning'
  })
}

export async function activateModel(
  modelId: string,
  requestedKind?: string
): Promise<{ success: boolean; error?: string }> {
  const remote = parseRemoteVisionModelId(modelId)
  if (remote) {
    const server = getRemoteVisionServerSettings().servers.find(
      (candidate) => candidate.id === remote.serverId
    )
    const selected = server?.mediaModels ?? (server?.model ? { text: server.model } : {})
    const modality = (['text', 'image', 'video', 'transcription', 'voice'] as const).find(
      (kind) => selected[kind] === remote.modelId
    )
    // A server's Computer Use role model is activated as that role, as Tasks sets it.
    const role = (['grounding', 'decision'] as const).find(
      (candidate) => server?.roleModels?.[candidate] === remote.modelId
    )
    if (!modality && role) {
      useForTasks(role, modelId)
      return { success: true }
    }
    const activated =
      modality === 'text'
        ? activateRemoteVisionModel(remote.serverId, remote.modelId)
        : modality
          ? activateRemoteVisionMediaModel(remote.serverId, modality, remote.modelId)
          : false
    // Chat now runs remotely: the local chat engine lets go of its memory. Chat starts it again
    // on demand if the user switches back to a local model.
    if (activated && modality === 'text') {
      void llm.unload().catch((error) => console.error('[models] local chat unload failed', error))
    }
    return activated
      ? { success: true }
      : { success: false, error: 'Remote model is no longer available.' }
  }
  let kind: string | undefined
  let requestedModal: Modality | null = null
  if (modelId.startsWith('local:') || modelId.startsWith('external:')) {
    kind = getLocalModels().find((m) => m.id === modelId)?.kind
  } else {
    const { modelSupportsKind, resolveHuggingFaceModel } = await import('@offgrid/models')
    const CATALOG = await desktopCatalog()
    const downloaded = reconcileDownloadedModelRegistry(
      llm.getModelsDir(),
      CATALOG as unknown as CatalogEntry[]
    )
    const catalogEntry = CATALOG.find((m) => m.id === modelId)
    kind =
      downloadedVariant(downloaded, modelId)?.kind ??
      (catalogEntry ?? (await resolveHuggingFaceModel(modelId)))?.kind
    const requested = requestedKind as Parameters<typeof modelSupportsKind>[1]
    if (catalogEntry && requestedKind && modelSupportsKind(catalogEntry, requested)) {
      requestedModal = modalityForModel(requestedKind)
    }
    if (
      requestedKind === 'computer_use' &&
      catalogEntry?.tags?.some((tag) => tag.toLowerCase() === 'decision')
    ) {
      useForTasks('decision', modelId)
      return { success: true }
    }
  }
  const modal = requestedModal ?? modalityForModel(kind)
  const result = modal ? await setActiveModalChoice(modal, modelId) : await setActiveModel(modelId)
  return result
}

/** The file an image or video engine loads for a catalog or package id, or undefined. */
async function mediaModelFileName(
  modal: 'image' | 'video',
  modelId: string
): Promise<string | undefined> {
  try {
    const CATALOG = await desktopCatalog()
    const e = CATALOG.find((m) => m.id === modelId)
    // The catalog's own pack wins when all its files are here; a variant of the same family
    // (another quantization) stands in only when it is not.
    const catalogPackHere =
      e &&
      (e.files as { name: string }[]).every(
        (file) => fileSizeOf(llm.getModelsDir(), file.name) > 0
      )
    const downloaded = catalogPackHere
      ? undefined
      : downloadedVariant(
          reconcileDownloadedModelRegistry(
            llm.getModelsDir(),
            CATALOG as unknown as CatalogEntry[]
          ),
          modelId
        )
    const { isSupportedVideoWeight } = await import('@offgrid/models')
    // A video pack's weight is the file the engine loads, not the pack's first file.
    return modal === 'video' && downloaded
      ? downloaded.files.find((file) => isSupportedVideoWeight(file))
      : e
        ? primaryFileName(e as unknown as CatalogEntry)
        : downloaded
          ? downloadedPrimary(downloaded)
          : undefined
  } catch {
    return undefined
  }
}

/**
 * The video pack file for an id a client picked from /v1/models/catalog. A video request names
 * the model the same way activation does, so both resolve it here.
 */
export function videoModelFileName(modelId: string): Promise<string | undefined> {
  return mediaModelFileName('video', modelId)
}

export async function setActiveModalChoice(
  kind: string,
  modelId: string | null
): Promise<{ success: boolean; error?: string }> {
  // Normalize to the storage modality so BOTH vocabularies work — the setup path
  // passes 'voice', the UI/dispatch pass 'speech'. Before this, the guard only
  // accepted 'speech', so "Configure for me" (which passes 'voice') silently failed
  // to activate TTS (D26). One normalizer is the single source of truth.
  const modal = modalityForModel(kind)
  if (modal) {
    let stored = modelId
    // The image resolver loads by FILENAME, but the UI passes a catalog id — map it
    // to the entry's primary filename so an in-app pick (e.g. Juggernaut) takes effect.
    if (modelId && (modal === 'image' || modal === 'video')) {
      stored = (await mediaModelFileName(modal, modelId)) ?? modelId
    }
    setModal(modal, stored)
    if (modal === 'video') deactivateRemoteVisionMediaModel('video')
    // A Computer Use pick, from any screen, is the grounding specialist both tasks share.
    if (modal === 'computer_use' && modelId) setTaskRoleModel('computer_use', 'grounding', modelId)
    if (modal === 'image') deactivateRemoteVisionMediaModel('image')
    if (modal === 'speech') deactivateRemoteVisionMediaModel('voice')
    if (modal === 'transcription') deactivateRemoteVisionMediaModel('transcription')
    return { success: true }
  }
  return { success: false, error: 'use setActiveModel for the chat LLM (text/vision)' }
}

export function getActiveModalities(): { text: string | null } & Record<Modality, string | null> {
  const settings = getRemoteVisionServerSettings()
  // Each modality's model comes from the server that modality runs on, or is local.
  const remoteId = (
    modality: 'text' | 'image' | 'video' | 'transcription' | 'voice'
  ): string | null => {
    const remote = settings.servers.find((server) => server.id === remoteServerIdFor(modality))
    const model =
      remote?.mediaModels?.[modality] ?? (modality === 'text' ? remote?.model : undefined)
    return remote && model ? remoteVisionModelId(remote.id, model) : null
  }
  return {
    text: remoteId('text') ?? getActiveModel(),
    ...getAllActiveModals(),
    video: remoteId('video') ?? getAllActiveModals().video,
    image: remoteId('image') ?? getAllActiveModals().image,
    speech: remoteId('voice') ?? getAllActiveModals().speech,
    transcription: remoteId('transcription') ?? getAllActiveModals().transcription
  }
}

// ---------------------------------------------------------------------------
// Local model import: a registry of user-imported .gguf files (not in the
// catalog), wired through list/activate/delete/storage so they behave like any
// other installed model — and are protected from orphan cleanup.
// ---------------------------------------------------------------------------

export interface LocalModel {
  id: string
  name: string
  primary: string
  mmproj?: string
  kind: 'text' | 'vision'
  params?: number
  sizeBytes: number
}

export type TransferableModelSource = 'catalog' | 'downloaded' | 'local'

export interface TransferableModelFile {
  name: string
  sizeBytes: number
  path: string
}

export interface TransferableModel {
  id: string
  familyId: string
  packageIdentity?: string
  name: string
  kind: string
  source: TransferableModelSource
  files: TransferableModelFile[]
}

function localRegistryFile(dir = llm.getModelsDir()): string {
  return path.join(dir, 'local-models.json')
}

export function getLocalModels(dir = llm.getModelsDir()): LocalModel[] {
  let managed: LocalModel[] = []
  try {
    const arr = JSON.parse(
      fs.readFileSync(
        modelMetadataFile(
          'local-models.json',
          dir === llm.getModelsDir() ? modelReadDirectories() : [dir]
        ),
        'utf-8'
      )
    )
    // A row without an id or a primary file names no usable model (a hand-edited copy).
    managed = Array.isArray(arr)
      ? arr.filter(
          (entry): entry is LocalModel =>
            typeof entry?.id === 'string' && typeof entry.primary === 'string'
        )
      : []
  } catch {
    /* no imported models */
  }
  if (dir !== llm.getModelsDir()) return managed
  const known = new Set([
    ...managed.map((model) => resolveModelReference(model.primary)),
    ...readDownloaded(dir).flatMap((model) =>
      model.files.map((name) => resolveModelReference(name))
    ),
    ...[...desktopEntries(), ...baseCatalog()].flatMap((model) =>
      model.files.flatMap((file) =>
        modelReadDirectories().flatMap((root) => {
          const asset = resolveModelAsset(file.name, [root])
          return asset ? [asset] : []
        })
      )
    )
  ])
  return [
    ...managed,
    ...discoverExternalModels(undefined, undefined, dir, readModelScanFolders(dataDir())).filter(
      (model) => !known.has(model.primary)
    )
  ]
}
function saveLocalModels(list: LocalModel[], dir = llm.getModelsDir()): void {
  try {
    fs.writeFileSync(
      localRegistryFile(dir),
      JSON.stringify(
        list.filter((model) => !model.id.startsWith('external:')),
        null,
        2
      )
    )
  } catch {
    /* best effort */
  }
}

function transferredFilesOnDisk(
  dir: string,
  files: Array<{ name: string; sizeBytes: number }>,
  readPaths?: Map<string, string>
): { error?: string; files?: TransferableModelFile[] } {
  const manifestError = modelTransferManifestFileError(files)
  if (manifestError) return { error: manifestError }
  const resolved: TransferableModelFile[] = []
  for (const file of files) {
    const filePath = readPaths?.get(file.name) ?? path.join(dir, file.name)
    let actualSize = 0
    try {
      const stat = fs.lstatSync(filePath)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { error: `${file.name}: transferred file is not a regular file` }
      }
      actualSize = stat.size
    } catch {
      return { error: `${file.name}: transferred file is missing` }
    }
    if (actualSize !== file.sizeBytes) {
      return { error: `${file.name}: transferred file size does not match the manifest` }
    }
    if (/\.gguf$/i.test(file.name) && !isValidGgufFile(filePath, fs)) {
      return { error: `${file.name}: transferred file is not a valid GGUF model` }
    }
    resolved.push({ ...file, path: filePath })
  }
  return { files: resolved }
}

/**
 * Resolve one installed, file-backed model for device transfer. Runtime caches such as mflux are
 * intentionally excluded because they are directory trees, not portable model files.
 */
export async function getTransferableModel(
  modelId: string,
  dir = llm.getModelsDir()
): Promise<TransferableModel | null> {
  const local = getLocalModels(dir).find((model) => model.id === modelId)
  const CATALOG = await desktopCatalog()
  const catalog = CATALOG.find((model) => model.id === modelId)
  const downloaded = downloadedVariant(
    reconcileDownloadedModelRegistry(dir, CATALOG as unknown as CatalogEntry[]),
    modelId
  )

  const source: TransferableModelSource | null = local
    ? 'local'
    : downloaded
      ? 'downloaded'
      : catalog && catalog.runtime !== 'mflux'
        ? 'catalog'
        : null
  if (!source) return null

  const names = local
    ? [local.primary, local.mmproj].filter((name): name is string => Boolean(name))
    : downloaded
      ? downloaded.files
      : (catalog?.files.map((file) => file.name) ?? [])
  // Registry references may point to a folder left in place. Transfer manifests
  // still use relative filenames, while the read path comes from the shared lookup.
  const references = names.map((name) => ({
    name: path.isAbsolute(name) ? path.basename(name) : name,
    path: modelFilePath(dir, name),
    sizeBytes: fileSizeOf(dir, name)
  }))
  const files = transferredFilesOnDisk(
    dir,
    references,
    new Map(references.map((file) => [file.name, file.path]))
  ).files
  if (!files) return null

  return {
    id: downloaded?.id ?? modelId,
    familyId: downloaded?.familyId ?? catalog?.id ?? local?.id ?? modelId,
    packageIdentity: downloaded?.packageIdentity,
    // Named from this model's own registry entry: the shared name cache may predate it.
    name: describeModel(local?.id ?? downloaded?.id ?? modelId, {
      catalog: DESKTOP_CATALOG,
      downloaded: downloaded ? [downloaded] : [],
      locals: local ? [local] : []
    }).displayName,
    kind: local?.kind ?? downloaded?.kind ?? catalog?.kind ?? 'text',
    source,
    files
  }
}

/**
 * Register model files only after the transfer owner has checksum-verified and atomically promoted
 * every file into the models directory. The catalog remains the source of truth for known models;
 * free-form and local models are recorded in their existing registries.
 */
export async function registerTransferredModel(
  manifest: TransferredModelManifest,
  dir = llm.getModelsDir()
): Promise<{ success: boolean; error?: string; id?: string }> {
  if (
    !manifest.id ||
    manifest.id.length > 512 ||
    !manifest.name ||
    manifest.name.length > 512 ||
    !manifest.kind ||
    manifest.kind.length > 128
  ) {
    return { success: false, error: 'model manifest is invalid' }
  }

  const resolved = transferredFilesOnDisk(dir, manifest.files)
  if (!resolved.files) return { success: false, error: resolved.error }

  // Projector presence is the package capability SSOT. A caller can still label an older catalog
  // entry as text, but the installed package and its deterministic identity must be vision.
  const projectorPresent = manifest.files.some(
    (file) => file.role === 'projector' || isProjectorFileName(file.name)
  )
  const normalizedManifest: TransferredModelManifest =
    projectorPresent && (manifest.kind === 'text' || manifest.kind === 'vision')
      ? { ...manifest, kind: 'vision' }
      : manifest

  const CATALOG = await desktopCatalog()
  const catalog = CATALOG.find((model) => model.id === normalizedManifest.id)
  if (catalog) {
    const expected = new Set<string>(catalog.files.map((file) => file.name))
    const received = new Set(normalizedManifest.files.map((file) => file.name))
    if (expected.size === received.size && [...expected].every((name) => received.has(name))) {
      return { success: true, id: normalizedManifest.id }
    }
    // A catalog id can have several valid quantizations and projector variants. The sender's
    // manifest owns the exact installed files; the catalog owns only its download variant.
    // Register a verified alternate variant below so it remains installed and transferable.
  }

  if (normalizedManifest.source === 'local') {
    const primary =
      normalizedManifest.files.find(
        (file) => /\.gguf$/i.test(file.name) && !/mmproj|projector/i.test(file.name)
      ) ?? normalizedManifest.files.find((file) => /\.gguf$/i.test(file.name))
    if (!primary) return { success: false, error: 'local model transfer requires a GGUF file' }
    const mmproj = normalizedManifest.files.find(
      (file) => file.name !== primary.name && /\.gguf$/i.test(file.name)
    )
    const id = `local:${primary.name}`
    const list = getLocalModels(dir).filter((model) => model.id !== id)
    list.push({
      id,
      name: normalizedManifest.name,
      primary: primary.name,
      mmproj: mmproj?.name,
      kind: mmproj ? 'vision' : 'text',
      sizeBytes: primary.sizeBytes
    })
    saveLocalModels(list, dir)
    if (!getLocalModels(dir).some((model) => model.id === id)) {
      return { success: false, error: 'could not register the transferred local model' }
    }
    return { success: true, id }
  }

  const exactPackageId =
    normalizedManifest.packageIdentity ?? modelPackageIdentity(normalizedManifest)
  recordDownloaded(dir, {
    id: exactPackageId,
    familyId: normalizedManifest.id,
    packageIdentity: exactPackageId,
    name: normalizedManifest.name,
    kind: normalizedManifest.kind,
    files: normalizedManifest.files.map((file) => file.name)
  })
  if (!findDownloaded(dir, exactPackageId)) {
    return { success: false, error: 'could not register the transferred model' }
  }
  if (dir === llm.getModelsDir()) {
    await reconcileActiveModelProjector().catch(() => false)
  }
  return { success: true, id: exactPackageId }
}

/** Set of every filename referenced by the local registry (primary + mmproj), so
 *  storage/orphan logic never deletes an imported model. */
function localProtectedNames(): Set<string> {
  const s = new Set<string>()
  for (const m of getLocalModels()) {
    s.add(m.primary)
    if (m.mmproj) s.add(m.mmproj)
  }
  return s
}

/** A real GGUF starts with the "GGUF" magic and is more than a few bytes. */
/** Import a local .gguf: validate, stream-copy into the models dir (with progress),
 *  and register it so it shows up as an installed, activatable model. */
export async function importLocalModel(
  srcPath: string,
  onProgress?: ProgressCb
): Promise<{ success: boolean; error?: string; id?: string }> {
  if (!srcPath || !srcPath.toLowerCase().endsWith('.gguf'))
    return { success: false, error: 'Not a .gguf file' }
  if (!isValidGgufFile(srcPath, fs))
    return { success: false, error: 'File is not a valid GGUF model (corrupt or wrong format)' }

  const dir = llm.getModelsDir()
  const storageError = modelStorageError()
  if (storageError) return { success: false, error: storageError }
  fs.mkdirSync(dir, { recursive: true })
  const fileName = path.basename(srcPath)
  const dest = path.join(dir, fileName)
  const id = `local:${fileName}`
  const total = fs.statSync(srcPath).size
  const name = describeModel(fileName, modelNameSources()).displayName
  const send = (data: Partial<DownloadProgress>): void => {
    onProgress?.({ modelId: id, modelName: name, ...data })
  }

  // Copy unless an identical-size file is already there.
  const already = fs.existsSync(dest) && fs.statSync(dest).size === total
  if (!already) {
    try {
      await new Promise<void>((resolve, reject) => {
        const rd = fs.createReadStream(srcPath)
        const wr = fs.createWriteStream(dest)
        let copied = 0
        rd.on('data', (c) => {
          copied += c.length
          send({
            status: 'downloading',
            percent: total ? Math.round((copied / total) * 100) : 0,
            currentFile: fileName
          })
        })
        rd.on('error', reject)
        wr.on('error', reject)
        wr.on('finish', () => resolve())
        rd.pipe(wr)
      })
    } catch (e) {
      try {
        fs.rmSync(dest, { force: true })
      } catch {
        /* ignore */
      }
      send({ status: 'failed', error: (e as Error).message })
      return { success: false, error: (e as Error).message }
    }
  }

  // Heuristic kind: a paired mmproj makes it vision; otherwise treat as text.
  const list = getLocalModels().filter((m) => m.id !== id)
  list.push({ id, name, primary: fileName, kind: 'text', sizeBytes: total })
  saveLocalModels(list)
  settingsChanged()
  send({ status: 'completed', percent: 100 })
  return { success: true, id }
}

// ---------------------------------------------------------------------------
// Storage: disk usage, free space, orphan cleanup
// ---------------------------------------------------------------------------

export interface ModelDiskEntry {
  id: string
  name: string
  kind?: string
  bytes: number
  active: boolean
}
export interface StorageInfo {
  dir: string
  unavailable?: string
  totalBytes: number // all model files (incl. orphans + .part) in the models dir
  freeBytes: number // free space on the volume
  models: ModelDiskEntry[]
  orphans: { name: string; bytes: number }[]
  /** Other large local data (videos and films, the document/search index), shown read-only. */
  dataUsage?: { id: string; label: string; count: number; bytes: number }[]
}

/** Disk usage for models: per installed model, total, free space, and orphan files
 *  (gguf/.part in the models dir that no catalog entry or active selection claims). */
export async function getStorageInfo(): Promise<StorageInfo> {
  const dir = llm.getModelsDir()
  const unavailable = modelStorageError()
  if (unavailable) return { dir, unavailable, totalBytes: 0, freeBytes: 0, models: [], orphans: [] }
  const CATALOG = await desktopCatalog()
  const catalog = CATALOG as unknown as CatalogEntry[]
  const reconciledDownloaded = reconcileDownloadedModelRegistry(dir, catalog)
  // Protect catalog + imported-local + free-form-download files, plus the active
  // chat selection's files, from being flagged/deleted as orphans.
  let activePrimary: string | null = null
  let activeMmproj: string | null = null
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'active-model.json'), 'utf-8'))
    activePrimary = cfg?.primary ?? null
    activeMmproj = cfg?.mmproj ?? null
  } catch {
    /* none */
  }
  const known = protectedNames({
    catalog,
    localNames: localProtectedNames(),
    downloadedNames: downloadedProtectedNames(dir),
    activePrimary,
    activeMmproj
  })

  // Runtime discovery also accepts complete local video packs that were copied
  // into the model directory. Their files must not become orphan-cleanup targets.
  for (const name of await installedVideoFileNames()) known.add(name)

  const active = getActiveModel()
  // Per-modality active picks (image/speech/transcription) are stored as the
  // chosen FILENAME, not the catalog id — so an image/voice/STT model is "active"
  // when its primary file matches. Without this, only the chat LLM ever shows
  // active and image models can't be activated from the UI.
  const modals = getAllActiveModals()
  const locals = getLocalModels()
  const installed = (await listInstalled()).filter((id) => !parseRemoteVisionModelId(id))
  const sizeOf = (name: string): number => fileSizeOf(dir, name)
  const downloaded = reconciledDownloaded
  const catalogIds = new Set(catalog.map((m) => m.id))
  const catalogById = (id: string): CatalogEntry | undefined => catalog.find((m) => m.id === id)
  const models: ModelDiskEntry[] = installed
    .map((id) =>
      buildDiskEntry({
        id,
        locals,
        downloaded,
        catalogById,
        isCatalogId: (x) => catalogIds.has(x),
        activeChatId: active,
        modals,
        sizeOf
      })
    )
    .map((entry) => ({
      ...entry,
      name: describeModel(entry.id, {
        catalog,
        downloaded,
        locals,
        remote: modelNameSources().remote
      }).displayName
    }))

  let entries: string[] = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    /* no dir yet */
  }
  const statFile = (name: string): { isFile: boolean; size: number } | null => {
    try {
      const st = fs.statSync(path.join(dir, name))
      return { isFile: st.isFile(), size: st.size }
    } catch {
      return null
    }
  }
  const scanned = scanModelDir({ entries, known, statFile })
  // The generic scanner predates directory-backed packages and scans root GGUF
  // files. Count managed Kev files here. A reused legacy base is outside this
  // models directory and is not app-managed storage.
  const nestedModelBytes = KEV_MODELS.flatMap((model) => model.files).reduce((sum, file) => {
    if (!file.name.includes('/')) return sum
    try {
      return sum + fs.statSync(path.join(dir, file.name)).size
    } catch {
      return sum
    }
  }, 0)
  // Search (embedding) models live in the Transformers.js cache folder, not the scanned root.
  const embeddingModels = (await import('./embedding-setup-download')).installedEmbeddingModels()
  models.push(...embeddingModels)
  const embeddingBytes = embeddingModels.reduce((sum, model) => sum + model.bytes, 0)
  const totalBytes = scanned.totalBytes + nestedModelBytes + embeddingBytes
  const { orphans } = scanned

  let freeBytes = 0
  try {
    const s = fs.statfsSync(dir)
    freeBytes = s.bavail * s.bsize
  } catch {
    /* unknown */
  }
  let dataUsage: StorageInfo['dataUsage']
  try {
    dataUsage = (await import('./data-privacy')).getStoredDataUsage()
  } catch {
    /* no database yet */
  }
  return { dir, totalBytes, freeBytes, models, orphans, dataUsage }
}

/** Delete every orphan file (unreferenced gguf/.part). Recomputes the orphan set so
 *  it can never touch a catalog model or the active selection. */
export async function deleteOrphans(): Promise<{
  success: boolean
  count: number
  freedBytes: number
}> {
  try {
    return await deleteOrphanFiles()
  } finally {
    settingsChanged()
  }
}

async function deleteOrphanFiles(): Promise<{
  success: boolean
  count: number
  freedBytes: number
}> {
  const info = await getStorageInfo()
  const dir = llm.getModelsDir()
  let freedBytes = 0,
    count = 0
  for (const o of info.orphans) {
    try {
      fs.rmSync(path.join(dir, o.name), { force: true })
      freedBytes += o.bytes
      count++
    } catch {
      /* ignore */
    }
  }
  return { success: true, count, freedBytes }
}

// ---------------------------------------------------------------------------
// Download registry: surface active/failed/completed downloads + retry, and
// survive an app restart (an interrupted download becomes resumable).
// ---------------------------------------------------------------------------

function downloadsFile(): string {
  return path.join(llm.getModelsDir(), 'downloads.json')
}
let registryLoaded = false
function ensureRegistryLoaded(): void {
  if (registryLoaded) return
  registryLoaded = true
  try {
    const arr = JSON.parse(fs.readFileSync(downloadsFile(), 'utf-8')) as DownloadProgress[]
    for (const p of arr) {
      // Anything still active/queued when we last wrote was cut off by a quit/crash.
      // Surface it as explicitly retryable instead of leaving a queue row that can
      // never drain in this fresh process.
      if (p.status === 'downloading' || p.status === 'queued') {
        p.status = 'failed'
        p.error = DOWNLOAD_INTERRUPTED_ERROR
      }
      // Rows saved by earlier builds carry no name.
      p.modelName = displayModelName(p.modelId) ?? p.modelId
      lastProgress.set(p.modelId, p)
    }
  } catch {
    /* no registry yet */
  }
}
function persistRegistry(): void {
  try {
    const arr = Array.from(lastProgress.values()).filter((p) => p.status !== 'completed')
    if (arr.length) fs.writeFileSync(downloadsFile(), JSON.stringify(arr))
    else fs.rmSync(downloadsFile(), { force: true })
  } catch {
    /* best effort */
  }
}

/** All known downloads (active, failed, interrupted) for a download-manager view. */
export function listDownloads(): DownloadProgress[] {
  ensureRegistryLoaded()
  return Array.from(lastProgress.values())
}

/** Retry (resumes from the partial .part) a failed/interrupted download. */
export async function retryDownload(
  modelId: string,
  onProgress?: ProgressCb
): Promise<{ success: boolean; error?: string }> {
  return downloadModel(modelId, onProgress)
}

/** Dismiss a download-manager entry: abort it if still running, delete its partial
 *  .part files, and drop it from the registry so it leaves the Downloads list. */
export async function clearDownload(
  modelId: string
): Promise<{ success: boolean; freedBytes: number }> {
  cancelDownload(modelId) // no-op if not currently downloading
  let freedBytes = 0
  try {
    const dir = llm.getModelsDir()
    const { resolveHuggingFaceModel } = await import('@offgrid/models')
    const CATALOG = await desktopCatalog()
    const entry =
      CATALOG.find((m) => m.id === modelId) ??
      (await resolveHuggingFaceModel(modelId).catch(() => null))
    for (const f of entry?.files ?? []) {
      const part = path.join(dir, `${f.name}.part`)
      try {
        const bytes = fs.statSync(part).size
        fs.rmSync(part, { force: true })
        freedBytes += bytes
      } catch {
        /* no partial file or removal failed */
      }
    }
  } catch {
    /* best effort */
  }
  ensureRegistryLoaded()
  lastProgress.delete(modelId)
  persistRegistry()
  return { success: true, freedBytes }
}

/** Clear every failed/cancelled/interrupted download (entry + .part). */
export async function clearInactiveDownloads(): Promise<{
  success: boolean
  count: number
  freedBytes: number
}> {
  ensureRegistryLoaded()
  const ids = Array.from(lastProgress.values())
    .filter((p) => p.status === 'failed' || p.status === 'cancelled')
    .map((p) => p.modelId)
  let freedBytes = 0
  for (const id of ids) {
    const r = await clearDownload(id)
    freedBytes += r.freedBytes
  }
  let count = ids.length
  // A transfer interrupted in an earlier session (quit, crash, power loss) has no entry above,
  // but its .part file still holds disk space. With nothing downloading or queued, every
  // remaining .part file is an incomplete transfer.
  const transfers = downloadQueue.counts()
  if (transfers.running === 0 && transfers.queued === 0) {
    const dir = llm.getModelsDir()
    let entries: string[] = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      /* no models folder yet */
    }
    for (const name of entries) {
      if (!name.endsWith('.part')) continue
      const part = path.join(dir, name)
      try {
        const st = fs.statSync(part)
        if (!st.isFile()) continue
        fs.rmSync(part, { force: true })
        freedBytes += st.size
        count++
      } catch {
        /* removal failed; leave it for the next cleanup */
      }
    }
  }
  return { success: true, count, freedBytes }
}
