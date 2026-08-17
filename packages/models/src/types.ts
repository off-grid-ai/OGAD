// Model management types, cross-platform.
//
// Off Grid supports several model KINDS (and more soon): a text LLM, a
// vision/multimodal LLM, image generation, voice (TTS), and transcription (STT).
// The catalog and downloader are kind-agnostic; the host runtime knows how to
// load each kind.

import type { ImageGenMode } from './imagegen'

export type ModelKind = 'text' | 'vision' | 'image' | 'voice' | 'transcription'

export interface ModelFile {
  /** Filename on disk, e.g. "Qwen3.5-2B-Q4_K_M.gguf". */
  name: string
  /** Download URL (often a Hugging Face resolve URL). */
  url: string
  /** Size in bytes when known (for progress + RAM/disk checks). */
  sizeBytes?: number
  /** Expected SHA-256 (HuggingFace lfs oid) when known — the download is verified
   *  against it before being promoted to installed. Absent = no checksum check. */
  sha256?: string
  /** Marks an auxiliary file (e.g. a vision mmproj) vs the primary weights. */
  role?: 'primary' | 'mmproj' | 'tokenizer' | 'aux'
}

export interface ModelEntry {
  /** Stable id, usually the HF repo id, e.g. "unsloth/Qwen3.5-2B-GGUF". */
  id: string
  name: string
  kind: ModelKind
  /** Provider/org, e.g. "google", "Qwen", "openai-whisper". */
  org?: string
  description?: string
  /** Billions of parameters (LLMs); omitted for non-LLM kinds. */
  params?: number
  /** Minimum device RAM (GB) recommended. */
  minRamGb?: number
  /** Quantization label, e.g. "Q4_K_M". */
  quant?: string
  /** Files to download for this model. */
  files: ModelFile[]
  /** For image models: which generation modes it supports (txt2img/img2img). */
  imageModes?: ImageGenMode[]
  isNew?: boolean
  /** A GUI-grounding vision model (UI-TARS, Holo, GUI-Owl): given a screenshot it
   *  outputs precise click coordinates. Unlike `kind` (derived from files), grounder-
   *  ness is not a file fact - a grounder and a general VLM both ship an mmproj - so
   *  it is a model-identity flag. Used to WARN (never block) when the vision rail
   *  runs on a non-grounder. */
  grounder?: boolean
  /** Short capability labels shown as chips, e.g. ['Recommended','Fast','Photoreal']. */
  tags?: string[]
  /** Which on-device runtime serves this model. Default 'sd-cli' (stable-diffusion.cpp).
   *  'mflux' = the bundled MLX runtime (Apple-Silicon-only; fetches its own weights). */
  runtime?: 'sd-cli' | 'mflux'
  /** For transcription models: which STT engine serves it. Default 'whisper' when
   *  omitted. 'parakeet' models are multi-file ONNX sets run by the sherpa-onnx CLI. */
  engine?: 'whisper' | 'parakeet'
  /** Release date (ISO yyyy-mm-dd), from the source repo's createdAt. Shown on the
   *  card and used to surface only recent ("post-Jan-2026") small models. */
  releaseDate?: string
}

/** RAM tier -> max model size + quant, for recommending a default model. */
export interface ModelRecommendationTier {
  minRamGb: number
  maxRamGb: number
  maxParams: number
  quantization: string
}

export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'failed'

export interface DownloadProgress {
  modelId: string
  status: DownloadStatus
  /** 0..1 across all of the model's files. */
  progress: number
  bytesDownloaded: number
  totalBytes: number
  currentFile?: string
  speedBytesPerSec?: number
  error?: string
}

/** Platform file download (Node/Electron streams to disk; RN background downloader). */
export interface DownloadBridge {
  /** Download `url` to `destPath`. Resume if a partial file exists. Returns the
   * bytes written. Call onProgress(bytesWritten, totalBytes) as it streams. */
  download(
    url: string,
    destPath: string,
    opts: { onProgress?: (written: number, total: number) => void; signal?: AbortSignal }
  ): Promise<number>
  /** Whether a fully-downloaded file already exists (size match). */
  exists(destPath: string, expectedBytes?: number): Promise<boolean>
  /** Join the models directory with a filename. */
  pathFor(fileName: string): string
}

/** Records which models are installed (a memory entity or local store). */
export interface ModelStore {
  markInstalled(entry: ModelEntry): void
  isInstalled(modelId: string): boolean
  installed(): ModelEntry[]
  remove(modelId: string): void
}
