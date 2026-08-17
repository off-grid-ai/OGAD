import { M as ModelEntry, a as ModelKind, b as ModelRecommendationTier, c as ModelFile, D as DownloadBridge, d as ModelStore, e as DownloadProgress } from './types-Cp-D96rw.js';
export { f as DownloadStatus, I as ImageGenMode, g as ImageGenProvider, h as ImageGenRequest, i as ImageGenResult, s as supportsMode, v as validateImageGenRequest } from './types-Cp-D96rw.js';

declare const RECOMMENDATION_TIERS: ModelRecommendationTier[];
declare function recommendForRam(ramGb: number): ModelRecommendationTier;
declare const CATALOG: ModelEntry[];
declare function modelsByKind(kind: ModelKind): ModelEntry[];
/** Whether a model grounds GUI clicks (the desktop vision rail's ideal input).
 *  Catalogued models answer from their `grounder` flag - the single source of
 *  truth; an off-catalog id/name falls back to the known-family heuristic. Used
 *  to WARN, never to block: the vision rail stays model-agnostic. */
declare function isGrounderModel(idOrName: string, catalog?: ModelEntry[]): boolean;
declare const MODEL_KINDS: ModelKind[];

/** True iff the file set includes a vision projector (mmproj). This is what actually
 *  gives a chat model image input at load time. */
declare function hasVisionProjector(files: readonly ModelFile[]): boolean;
/** Derive a model's kind from its files: a projector upgrades a chat model to vision.
 *  Non-chat kinds (image/voice/transcription) are returned unchanged — an mmproj is a
 *  chat/VLM concept and never reclassifies them. */
declare function deriveKind(files: readonly ModelFile[], declared: ModelKind): ModelKind;

declare class ModelDownloader {
    private readonly bridge;
    private readonly store;
    private aborts;
    private listeners;
    constructor(bridge: DownloadBridge, store: ModelStore);
    onProgress(cb: (p: DownloadProgress) => void): () => void;
    isInstalled(modelId: string): boolean;
    cancel(modelId: string): void;
    private emit;
    download(entry: ModelEntry): Promise<boolean>;
}

type Credibility = 'offgrid' | 'official' | 'verified-quantizer' | 'community';
declare const OFFICIAL_MODEL_AUTHORS: Record<string, string>;
declare const VERIFIED_QUANTIZERS: Record<string, string>;
declare const CREDIBILITY_LABELS: Record<Credibility, {
    label: string;
    description: string;
    color: string;
}>;
/** Classify a HF author into a credibility tier. */
declare function determineCredibility(author: string): Credibility;

type FetchLike$1 = (url: string, init?: {
    headers?: Record<string, string>;
}) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
}>;
interface HFSearchResult {
    id: string;
    name: string;
    org: string;
    downloads?: number;
    likes?: number;
    lastModified?: string;
    credibility: Credibility;
}
/** A selectable quantization variant within a HF repo (for the file picker). */
interface ModelFileVariant {
    fileName: string;
    quant: string;
    quality: string;
    recommended: boolean;
    sizeBytes: number;
    downloadUrl: string;
    /** Matched vision projector for this weight, when the repo is multimodal. */
    mmproj?: {
        fileName: string;
        url: string;
        sizeBytes?: number;
    };
}
/** Search the HF hub for models, scoped to a modality (kind) when given so each
 *  tab only surfaces models it can actually use. */
declare function searchHuggingFace(query: string, opts?: {
    limit?: number;
    sort?: string;
    kind?: ModelKind;
    fetchImpl?: FetchLike$1;
}): Promise<HFSearchResult[]>;
/** List a repo's GGUF quantization variants (with matched mmproj), for a file
 * picker. Sorted recommended-first, then smallest. */
declare function getModelFiles(repoId: string, opts?: {
    fetchImpl?: FetchLike$1;
}): Promise<ModelFileVariant[]>;
/**
 * Resolve a HF repo into a downloadable ModelEntry: a primary GGUF (preferring
 * Q4_K_M) plus a matching mmproj when the repo is multimodal. Returns null if no
 * usable GGUF is found.
 */
declare function resolveHuggingFaceModel(repoId: string, opts?: {
    kind?: ModelKind;
    fetchImpl?: FetchLike$1;
}): Promise<ModelEntry | null>;

interface QuantInfo {
    bitsPerWeight: number;
    quality: string;
    description: string;
    recommended: boolean;
}
declare const QUANTIZATION_INFO: Record<string, QuantInfo>;
/** Extract a quantization label from a GGUF filename. */
declare function extractQuantization(fileName: string): string;
declare function isMMProjFile(fileName: string): boolean;
declare function formatFileSize(bytes: number): string;

type ChatRole = 'system' | 'user' | 'assistant';
interface ChatMessage {
    role: ChatRole;
    content: string;
}
interface ChatOptions {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
}
interface ProviderModel {
    id: string;
    name: string;
}
/** Local or remote LLM. chat() streams text chunks. */
interface InferenceProvider {
    readonly id: string;
    readonly name: string;
    listModels(): Promise<ProviderModel[]>;
    chat(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<string>;
}
type RemoteServerKind = 'openai' | 'ollama';
interface RemoteServerConfig {
    id: string;
    name: string;
    kind: RemoteServerKind;
    /** Base URL. OpenAI-compatible includes the /v1 suffix; Ollama is the host root. */
    endpoint: string;
    apiKey?: string;
}
interface FetchResponse {
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    body: ReadableStream<Uint8Array> | null;
}
type FetchLike = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}) => Promise<FetchResponse>;
/** OpenAI-compatible provider: local llama-server, LM Studio, LocalAI, OpenAI. */
declare function openAICompatibleProvider(cfg: {
    id: string;
    name: string;
    endpoint: string;
    apiKey?: string;
    fetchImpl?: FetchLike;
}): InferenceProvider;
/** Ollama provider (/api/tags, /api/chat NDJSON). */
declare function ollamaProvider(cfg: {
    id: string;
    name: string;
    endpoint: string;
    fetchImpl?: FetchLike;
}): InferenceProvider;
/** Build a provider from a remote server config. */
declare function createProvider(server: RemoteServerConfig, fetchImpl?: FetchLike): InferenceProvider;
/** Registry of available providers (local + remote) with an active selection. */
declare class ProviderRegistry {
    private providers;
    private activeId;
    register(provider: InferenceProvider): void;
    unregister(id: string): void;
    list(): InferenceProvider[];
    setActive(id: string): void;
    active(): InferenceProvider | null;
}

type ModelTypeFilter = 'all' | 'text' | 'vision' | 'code' | 'image-gen';
type CredibilityFilter = 'all' | Credibility;
type SizeFilter = 'all' | 'tiny' | 'small' | 'medium' | 'large';
type SortOption = 'recommended' | 'bestfit' | 'size' | 'downloads' | 'recency';
interface FilterState {
    orgs: string[];
    type: ModelTypeFilter;
    source: CredibilityFilter;
    size: SizeFilter;
    quant: string;
    sort: SortOption;
}
declare const initialFilterState: FilterState;
/** Normalized model the filters/sorts operate on (map HF results into this). */
interface FilterableModel {
    id: string;
    name: string;
    org: string;
    credibility?: Credibility;
    params?: number | null;
    tags?: string[];
    downloads?: number;
    likes?: number;
    lastModified?: string;
    minRamGb?: number;
    files?: {
        sizeBytes?: number;
        quant?: string;
    }[];
}
declare const SIZE_OPTIONS: readonly [{
    readonly key: "tiny";
    readonly label: "Tiny (<2B)";
    readonly min: 0;
    readonly max: 2;
}, {
    readonly key: "small";
    readonly label: "Small (2-5B)";
    readonly min: 2;
    readonly max: 5;
}, {
    readonly key: "medium";
    readonly label: "Medium (5-15B)";
    readonly min: 5;
    readonly max: 15;
}, {
    readonly key: "large";
    readonly label: "Large (15B+)";
    readonly min: 15;
    readonly max: number;
}];
declare const MODEL_TYPE_OPTIONS: readonly [{
    readonly key: "text";
    readonly label: "Text";
}, {
    readonly key: "vision";
    readonly label: "Vision";
}, {
    readonly key: "code";
    readonly label: "Code";
}, {
    readonly key: "image-gen";
    readonly label: "Image";
}];
declare const CREDIBILITY_OPTIONS: readonly [{
    readonly key: "offgrid";
    readonly label: "Off Grid";
}, {
    readonly key: "official";
    readonly label: "Official";
}, {
    readonly key: "verified-quantizer";
    readonly label: "Verified";
}, {
    readonly key: "community";
    readonly label: "Community";
}];
declare const SORT_OPTIONS: readonly [{
    readonly key: "recommended";
    readonly label: "Recommended";
}, {
    readonly key: "bestfit";
    readonly label: "Best fit";
}, {
    readonly key: "downloads";
    readonly label: "Downloads";
}, {
    readonly key: "size";
    readonly label: "Size";
}, {
    readonly key: "recency";
    readonly label: "Recent";
}];
/** Parse a billions-of-parameters count from a model name/id, in billions
 *  ("Qwen3.5-2B" -> 2, "SmolVLM2-500M" -> 0.5). Returns null if none found. */
declare function parseParamCount(nameOrId: string): number | null;
/** Detect a model's type from its name + tags. */
declare function getModelType(name: string, tags?: string[]): ModelTypeFilter;
/** Lower is better. Ideal model uses ~40% of RAM; penalize >75% (too slow). */
declare function bestFitScore(m: FilterableModel, ramGb: number): number;
declare function hasActiveFilters(state: FilterState): boolean;
declare function applyFilters<T extends FilterableModel>(models: T[], state: FilterState): T[];
declare function applySort<T extends FilterableModel>(models: T[], sort: SortOption, ramGb?: number): T[];
/** Apply filters then sort in one pass. */
declare function filterAndSort<T extends FilterableModel>(models: T[], state: FilterState, ramGb?: number): T[];

/** The minimal shape the recommendation reads — id, kind, tags. Structural so
 *  callers can pass either the package `ModelEntry` or a renderer-local model type
 *  (whose `kind` is a plain string) without a cast. */
interface RecommendableModel {
    id: string;
    kind: string;
    tags?: string[];
}
/** RAM (GB) at or below which the lighter (Light-tagged) quant is recommended.
 *  16GB is the ceiling: verified that the full Q8 DreamShaper pegs memory (~4.7GB
 *  peak) and can freeze a 16GB Mac, while the Q4 (~3.08GB peak) does not. */
declare const LIGHT_MODEL_RAM_CEILING_GB = 16;
/**
 * The image model id best suited to a machine with `ramGb` RAM, or null when no
 * image model qualifies. General over the 'Light' tag:
 *   - ramGb <= LIGHT_MODEL_RAM_CEILING_GB → prefer a Light-tagged image model;
 *   - ramGb >  ceiling                    → prefer the full (non-Light) sibling
 *                                            of a family that HAS a Light variant.
 * The "has a Light sibling" constraint keeps the badge on the versatile default
 * family (DreamShaper) rather than an unrelated heavy model. Falls back to any
 * Light model when only that exists (small machine) / the family's full entry.
 */
declare function recommendedImageModelId(models: RecommendableModel[], ramGb: number | null | undefined): string | null;

export { CATALOG, CREDIBILITY_LABELS, CREDIBILITY_OPTIONS, type ChatMessage, type ChatOptions, type ChatRole, type Credibility, type CredibilityFilter, DownloadBridge, DownloadProgress, type FetchLike, type FilterState, type FilterableModel, type HFSearchResult, type InferenceProvider, LIGHT_MODEL_RAM_CEILING_GB, MODEL_KINDS, MODEL_TYPE_OPTIONS, ModelDownloader, ModelEntry, ModelFile, type ModelFileVariant, ModelKind, ModelRecommendationTier, ModelStore, type ModelTypeFilter, OFFICIAL_MODEL_AUTHORS, type ProviderModel, ProviderRegistry, QUANTIZATION_INFO, type QuantInfo, RECOMMENDATION_TIERS, type RecommendableModel, type RemoteServerConfig, type RemoteServerKind, SIZE_OPTIONS, SORT_OPTIONS, type SizeFilter, type SortOption, VERIFIED_QUANTIZERS, applyFilters, applySort, bestFitScore, createProvider, deriveKind, determineCredibility, extractQuantization, filterAndSort, formatFileSize, getModelFiles, getModelType, hasActiveFilters, hasVisionProjector, initialFilterState, isGrounderModel, isMMProjFile, modelsByKind, ollamaProvider, openAICompatibleProvider, parseParamCount, recommendForRam, recommendedImageModelId, resolveHuggingFaceModel, searchHuggingFace };
