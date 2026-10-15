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

/**
 * Text -> vector. The actual inference, owned in ONE place.
 *
 * It runs in two contexts and must behave identically in both: the worker thread (production, where
 * keeping native ONNX inference off the main thread is the whole point - see embeddings-worker.ts), and
 * in-process, where there is no built worker to spawn. Sharing the implementation is what keeps the
 * second path honest: the alternative was a second copy that could drift from the one users run.
 *
 * Pipelines are cached per process and per model, because loading one is the expensive part.
 */
const pipes = new Map<string, Promise<FeatureExtractionPipeline>>()
let activeDevice: DeviceType | null = null

export function embeddingDevice(): DeviceType | null {
  return activeDevice
}

/** Called after serialized inference when the model is configured on demand. */
export async function disposeEmbeddingModel(): Promise<void> {
  const loaded = [...pipes.values()]
  pipes.clear()
  activeDevice = null
  for (const pipe of loaded) await (await pipe.catch(() => null))?.dispose()
  const reranker = rerankerLoading
  rerankerLoading = null
  await (await reranker?.catch(() => null))?.model.dispose()
}

/** A sentence embedder and the prefixes its training expects on questions and passages. */
export interface EmbedderSpec {
  model: string
  queryPrefix: string
  passagePrefix: string
}

export const EMBEDDERS = {
  /** English. Measured 3.3 ms a passage fp32 on CPU here; q8 was slower (30.6 ms). */
  miniLM: { model: 'Xenova/all-MiniLM-L6-v2', queryPrefix: '', passagePrefix: '' },
  /** Hindi and English in one space (a Hindi question finds the English passage). 7.9 ms a passage
   *  fp32; a ~470 MB download against MiniLM's ~90 MB. Trained with these prefixes. */
  multilingualE5Small: {
    model: 'Xenova/multilingual-e5-small',
    queryPrefix: 'query: ',
    passagePrefix: 'passage: '
  }
} as const satisfies Record<string, EmbedderSpec>

/** The model behind embeddings that have no corpus of their own (/v1/embeddings, MCP, tool routing). */
export const DEFAULT_EMBEDDER: EmbedderSpec = EMBEDDERS.miniLM

/**
 * The model memory search embeds records and questions with. Changing it is this one line: each
 * stored vector records its model, so every record is embedded again with the new one.
 */
export const RECORD_EMBEDDER: EmbedderSpec = EMBEDDERS.multilingualE5Small

/**
 * Models for documents (chat attachments, knowledge bases, transcripts): the same multilingual
 * embedder as memory search, so one model is loaded and a Hindi question finds an English passage.
 * fp32 is 7.9 ms a passage on CPU here (the ~1.7 s once measured was its q8 build). Documents
 * indexed with MiniLM re-embed on their next use: the ingest compares each document's embedder. Indian-language documents still match by
 * keyword (FTS5 keeps their words whole). ms-marco-MiniLM-L-6-v2 is the cross-encoder AnythingLLM's
 * native reranker uses.
 */
export const DOCUMENT_EMBEDDER_SPEC: EmbedderSpec = EMBEDDERS.multilingualE5Small
export const DOCUMENT_EMBEDDER = DOCUMENT_EMBEDDER_SPEC.model
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
 * Vectors for several texts with one model, in one forward pass. Document passages are close in
 * length, so padding costs little: measured 81 ms a passage batched against 186 ms one by one
 * (MiniLM fp32 on CPU, 1,000-character passages, app under load), with the same vectors (max
 * difference 1.5e-7). `onReady` hears the device once, when the model first loads.
 */
export async function embedTexts(
  texts: string[],
  model: string,
  modelsDir: string,
  onReady?: (device: string, reason?: string) => void,
  backendPreference: BackendPreference = 'auto',
  readDirectories = modelReadDirectories()
): Promise<number[][]> {
  if (!texts.length) return []
  const pipe = await loadPipeline(model, modelsDir, onReady, backendPreference, readDirectories)
  const output = await pipe(texts, { pooling: 'mean', normalize: true })
  return output.tolist() as number[][]
}

/** The model's pipeline: full-precision weights when present, else quantized; downloads on first use. */
function loadPipeline(
  model: string,
  modelsDir: string,
  onReady: ((device: string, reason?: string) => void) | undefined,
  backendPreference: BackendPreference,
  readDirectories: string[]
): Promise<FeatureExtractionPipeline> {
  const loaded = pipes.get(model)
  if (loaded) return loaded
  const fp32 = resolveTransformersPackage(model, 'model.onnx', readDirectories)
  const cached = fp32 ?? resolveTransformersPackage(model, 'model_quantized.onnx', readDirectories)
  // Local-only reads must not require writable storage. Guard only an explicit
  // folder choice when the pipeline can download; default storage is created lazily.
  if (!cached && process.env.OFFGRID_EMBEDDINGS_OFFLINE !== '1') requireModelStorage()
  configureTransformersEnv(modelsDir, !!cached)
  const loading = loadWithOnnxFallback(
    (device) =>
      pipeline('feature-extraction', cached ?? model, {
        device,
        ...(cached ? { local_files_only: true, ...(fp32 ? {} : { dtype: 'q8' as const }) } : {})
      }),
    embeddingDevices(backendPreference)
  ).then(({ runtime, device, fallbackReason }) => {
    onReady?.(device, fallbackReason)
    activeDevice = device
    return runtime
  })
  loading.catch(() => {
    if (pipes.get(model) === loading) pipes.delete(model)
  })
  pipes.set(model, loading)
  return loading
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
 * Devices for the embedders and the reranker: never CoreML on macOS, whatever the backend
 * preference. CoreML ran MiniLM at about 450 ms a passage against 50 ms on the CPU (measured
 * 2026-10-15, app under load), and the multilingual embedder on CoreML ended the whole app
 * mid-batch in the background indexer (no crash report; every "Memory indexing" request with
 * backend Core ML was interrupted by the app closing). A "metal" preference maps to CoreML for ONNX,
 * so excluding it only for "auto" was not enough.
 *
 * WebGPU only when the user picks it. A second process running the multilingual embedder on
 * WebGPU beside the app caused a GPU page fault (2026-10-15, gpuEvent "BIF0 page fault"); the GPU
 * restarted, llama-server answered every request with "Compute error", and WindowServer later hung
 * until the Mac was force-reset. Background indexing is not worth that risk, and on the CPU it
 * leaves the GPU to the chat model. A query vector costs about 60-90 ms on the CPU.
 */
function embeddingDevices(
  backendPreference: BackendPreference
): ReturnType<typeof onnxDeviceCandidates> {
  if (process.platform !== 'darwin') return onnxDeviceCandidates(process.platform, backendPreference)
  return backendPreference === 'webgpu' ? ['webgpu', 'cpu'] : ['cpu']
}
