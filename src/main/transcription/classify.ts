// Pure catalog-by-engine classification for transcription models. A LEAF module:
// it imports only the model catalog, never the engine CLIs. This is deliberate -
// whisper-cli and parakeet-cli need these classifiers, and select.ts needs both the
// classifiers AND the CLI singletons. If the classifiers lived in select.ts (which
// imports the CLIs), the CLIs importing them back would form a load-time cycle and
// select's `const ALL = { whisper, ... }` would read a not-yet-initialized singleton
// (a temporal-dead-zone crash on boot). Keeping them here breaks that cycle.
import { catalogModelsByKind } from '../models/remote-catalog'

/**
 * The catalog `engine` field for a transcription model: whisper (no `engine`), parakeet (the
 * sherpa-onnx CLI) or qwen3-asr (llama.cpp). Never a runtime-only value (whisper-resident is a
 * residency mode, not a catalog model). Single source of truth for classifying a catalog entry.
 */
export type CatalogTranscriptionEngine = 'whisper' | 'parakeet' | 'qwen3-asr'

/** A transcription catalog entry, narrowed to what engine classification needs. */
export type TranscriptionEntry = { id: string; engine?: string; files: Array<{ name: string }> }

/** The engine a catalog transcription entry belongs to. The catalog tags Parakeet and
 *  Qwen3-ASR entries; anything without a known tag is a whisper ggml model. Single source of
 *  truth so no caller re-does the classification. Pure. */
export function catalogEngine(
  entry: { engine?: string } | undefined | null
): CatalogTranscriptionEngine {
  return entry?.engine === 'parakeet' || entry?.engine === 'qwen3-asr' ? entry.engine : 'whisper'
}

/**
 * The transcription catalog entries for one engine. The one place the catalog is
 * partitioned by engine - whisper-cli (its whisper guard), parakeet-cli and qwen3-asr
 * (their own engine's models) all call this instead of re-filtering `catalogModelsByKind`.
 * Pure over the passed entries; the no-arg default reads the live catalog for callers.
 */
export function modelsByEngine(
  engine: CatalogTranscriptionEngine,
  entries: readonly TranscriptionEntry[] = catalogModelsByKind('transcription')
): TranscriptionEntry[] {
  return entries.filter((e) => catalogEngine(e) === engine)
}
