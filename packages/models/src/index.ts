// @offgrid/models - cross-platform model catalog + recommendation + download
// orchestration. Replaces a single fixed LLM with a full, multi-kind model
// manager (text, vision, image, voice, transcription; more soon). The actual
// file IO is a platform DownloadBridge (see ./node for desktop/Electron).

export * from './types'
export {
  CATALOG,
  MODEL_KINDS,
  RECOMMENDATION_TIERS,
  recommendForRam,
  modelsByKind,
  isGrounderModel
} from './catalog'
export { hasVisionProjector, deriveKind } from './capabilities'
export { ModelDownloader } from './download'
export { searchHuggingFace, resolveHuggingFaceModel, getModelFiles } from './hf'
export type { HFSearchResult, ModelFileVariant } from './hf'
export { QUANTIZATION_INFO, extractQuantization, isMMProjFile, formatFileSize } from './quant'
export type { QuantInfo } from './quant'
export {
  determineCredibility,
  CREDIBILITY_LABELS,
  OFFICIAL_MODEL_AUTHORS,
  VERIFIED_QUANTIZERS
} from './credibility'
export type { Credibility } from './credibility'
export * from './providers'
export * from './filters'
export { supportsMode, validateImageGenRequest } from './imagegen'
export type { ImageGenMode, ImageGenRequest, ImageGenResult, ImageGenProvider } from './imagegen'
export { recommendedImageModelId, LIGHT_MODEL_RAM_CEILING_GB } from './recommend-image'
export type { RecommendableModel } from './recommend-image'
