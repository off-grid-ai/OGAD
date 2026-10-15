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
import { loadWithOnnxFallback } from './onnx-device'
import type { OnnxDevice } from '@offgrid/models'
import { DOCUMENT_RERANKER } from './embedding-models'
export {
  DEFAULT_EMBEDDER,
  DOCUMENT_EMBEDDER,
  DOCUMENT_EMBEDDER_SPEC,
  DOCUMENT_RERANKER,
  RECORD_EMBEDDER,
  type EmbedderSpec
} from './embedding-models'

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
  devices: OnnxDevice[] = ['cpu'],
  readDirectories = modelReadDirectories()
): Promise<number[][]> {
  if (!texts.length) return []
  const pipe = await loadPipeline(model, modelsDir, onReady, devices, readDirectories)
  const output = await pipe(texts, { pooling: 'mean', normalize: true })
  return output.tolist() as number[][]
}

/** The model's pipeline: full-precision weights when present, else quantized; downloads on first use. */
function loadPipeline(
  model: string,
  modelsDir: string,
  onReady: ((device: string, reason?: string) => void) | undefined,
  devices: OnnxDevice[],
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
    embeddingDevices(devices)
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
  devices: OnnxDevice[] = ['cpu'],
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
        embeddingDevices(devices)
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

/** The host supplies the shared policy result to both execution paths. */
function embeddingDevices(devices: OnnxDevice[]): OnnxDevice[] {
  return devices
}
