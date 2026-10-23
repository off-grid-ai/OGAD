import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  pipeline,
  type DeviceType,
  type FeatureExtractionPipeline,
  type PreTrainedModel,
  type PreTrainedTokenizer
} from '@huggingface/transformers'
import { modelReadDirectories, resolveTransformersPackage } from './model-paths'
import { requireModelStorage } from './runtime-env'
import { configureTransformersEnv } from './embeddings-env'
import { loadWithOnnxFallback, onnxDeviceCandidates } from './onnx-device'
import type { BackendPreference } from '../shared/backend-preferences'
import { DEFAULT_EMBEDDING_MODEL, type EmbeddingModelId } from './embedding-model-choice'

export async function probeEmbeddingModel(
  modelId: EmbeddingModelId,
  modelsDir: string
): Promise<number> {
  configureTransformersEnv(modelsDir)
  const candidate = await pipeline('feature-extraction', modelId, { device: 'cpu' })
  try {
    const output = await candidate('Off Grid AI embedding check', {
      pooling: 'mean',
      normalize: true
    })
    const vector = Array.from(output.data)
    if (!vector.length || vector.length > 4096 || vector.some((value) => !Number.isFinite(value))) {
      throw new Error('This model returned an invalid embedding.')
    }
    return vector.length
  } finally {
    await candidate.dispose()
  }
}

/**
 * Text -> vector. The actual inference, owned in ONE place.
 *
 * It runs in two contexts and must behave identically in both: the worker thread (production, where
 * keeping native ONNX inference off the main thread is the whole point - see embeddings-worker.ts), and
 * in-process, where there is no built worker to spawn. Sharing the implementation is what keeps the
 * second path honest: the alternative was a second copy that could drift from the one users run.
 *
 * The pipeline is cached per process, because loading it is the expensive part.
 */
// One pipeline per model: search and memory use the chosen embedding model, attached documents
// always use DOCUMENT_EMBEDDER. When the two are the same model, they share one pipeline.
const pipes = new Map<string, Promise<FeatureExtractionPipeline>>()
let activeDevice: DeviceType | null = null

export function embeddingDevice(): DeviceType | null {
  return activeDevice
}

/** Called after serialized inference when the model is configured on demand. */
export async function disposeEmbeddingModel(): Promise<void> {
  const previous = [...pipes.values()]
  pipes.clear()
  activeDevice = null
  for (const loaded of previous) await (await loaded.catch(() => null))?.dispose()
  const reranker = rerankerLoading
  rerankerLoading = null
  await (await reranker?.catch(() => null))?.model.dispose()
}

/**
 * Models for documents attached to chat. Passages are embedded with MiniLM, the model memory search
 * already keeps loaded: measured ~15 ms a passage on CPU here, where multilingual-e5-small (q8) took
 * ~1.7 s, which made a long book index for over an hour. Indian-language documents still match by
 * keyword (FTS5 keeps their words whole). ms-marco-MiniLM-L-6-v2 is the cross-encoder AnythingLLM's
 * native reranker uses.
 */
export const DOCUMENT_EMBEDDER = 'Xenova/all-MiniLM-L6-v2'
export const DOCUMENT_RERANKER = 'Xenova/ms-marco-MiniLM-L-6-v2'

let rerankerLoading: Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> | null =
  null

/** Quantized weights when present (smaller download); the model downloads on first use. */
function prepareModel(id: string, modelsDir: string, readDirectories: string[]): boolean {
  const cached = !!resolveTransformersPackage(id, 'model_quantized.onnx', readDirectories)
  if (!cached && process.env.OFFGRID_EMBEDDINGS_OFFLINE !== '1') requireModelStorage()
  configureTransformersEnv(modelsDir, cached)
  return cached
}

/**
 * Vectors for several texts in one forward pass. Document passages are close in length, so padding
 * costs little: measured 81 ms a passage batched against 186 ms one by one (MiniLM fp32 on CPU,
 * 1,000-character passages, app under load), with the same vectors (max difference 1.5e-7).
 */
export async function embedTexts(
  texts: string[],
  modelsDir: string,
  backendPreference: BackendPreference = 'auto',
  readDirectories = modelReadDirectories()
): Promise<number[][]> {
  if (!texts.length) return []
  const pipe = await loadPipeline(
    DOCUMENT_EMBEDDER,
    modelsDir,
    undefined,
    backendPreference,
    readDirectories
  )
  const output = await pipe(texts, { pooling: 'mean', normalize: true })
  return output.tolist() as number[][]
}

/** Relevance of each passage to the query (sigmoid of the cross-encoder logit), same order. */
export async function rerankPassages(
  query: string,
  passages: string[],
  modelsDir: string,
  backendPreference: BackendPreference = 'auto',
  readDirectories = modelReadDirectories()
): Promise<number[]> {
  if (!passages.length) return []
  if (!rerankerLoading) {
    const cached = prepareModel(DOCUMENT_RERANKER, modelsDir, readDirectories)
    const options = cached ? { local_files_only: true } : {}
    rerankerLoading = Promise.all([
      AutoTokenizer.from_pretrained(DOCUMENT_RERANKER, options),
      loadWithOnnxFallback(
        (device) =>
          AutoModelForSequenceClassification.from_pretrained(DOCUMENT_RERANKER, {
            device,
            dtype: 'q8',
            ...options
          }),
        embeddingDevices(backendPreference)
      ).then(({ runtime }) => runtime)
    ]).then(([tokenizer, model]) => ({ tokenizer, model }))
    rerankerLoading.catch(() => {
      rerankerLoading = null
    })
  }
  const { tokenizer, model } = await rerankerLoading
  const scores: number[] = []
  // Small groups keep padding low; the model reads query and passage together.
  for (let i = 0; i < passages.length; i += 6) {
    const group = passages.slice(i, i + 6)
    const inputs = tokenizer(new Array(group.length).fill(query), {
      text_pair: group,
      padding: true,
      truncation: true
    })
    const { logits } = await model(inputs)
    const values = (logits.sigmoid().tolist() as number[][]).map((row) => row[0] ?? 0)
    scores.push(...values)
  }
  return scores
}

/**
 * Devices for the MiniLM embedder and the reranker. On macOS, CoreML ran MiniLM at about 450 ms a
 * passage against 50 ms on the CPU (measured 2026-10-15, app under load), so CPU is used unless the
 * user chose a backend.
 */
function embeddingDevices(backendPreference: BackendPreference): ReturnType<typeof onnxDeviceCandidates> {
  const devices = onnxDeviceCandidates(process.platform, backendPreference)
  return backendPreference === 'auto' && process.platform === 'darwin'
    ? devices.filter((device) => device !== 'coreml')
    : devices
}

export async function embedText(
  text: string,
  modelsDir: string,
  onReady?: (device: string, reason?: string) => void,
  backendPreference: BackendPreference = 'auto',
  modelId: EmbeddingModelId = DEFAULT_EMBEDDING_MODEL,
  readDirectories = modelReadDirectories()
): Promise<number[]> {
  const pipe = await loadPipeline(modelId, modelsDir, onReady, backendPreference, readDirectories)
  const output = await pipe(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}

function loadPipeline(
  modelId: EmbeddingModelId,
  modelsDir: string,
  onReady: ((device: string, reason?: string) => void) | undefined,
  backendPreference: BackendPreference,
  readDirectories: string[]
): Promise<FeatureExtractionPipeline> {
  const existing = pipes.get(modelId)
  if (existing) return existing
  const fp32 = resolveTransformersPackage(modelId, 'model.onnx', readDirectories)
  const cached =
    fp32 ?? resolveTransformersPackage(modelId, 'model_quantized.onnx', readDirectories)
  // Local-only reads must not require writable storage. Guard only an explicit
  // folder choice when the pipeline can download; default storage is created lazily.
  if (!cached && process.env.OFFGRID_EMBEDDINGS_OFFLINE !== '1') requireModelStorage()
  configureTransformersEnv(modelsDir, !!cached)
  const loading = loadWithOnnxFallback(
    (device) =>
      pipeline('feature-extraction', cached ?? modelId, {
        device,
        ...(cached ? { local_files_only: true, ...(fp32 ? {} : { dtype: 'q8' as const }) } : {})
      }),
    embeddingDevices(backendPreference)
  )
    .then(({ runtime, device, fallbackReason }) => {
      onReady?.(device, fallbackReason)
      activeDevice = device
      return runtime
    })
    .catch((error) => {
      pipes.delete(modelId)
      throw error
    })
  pipes.set(modelId, loading)
  return loading
}
