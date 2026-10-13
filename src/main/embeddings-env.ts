import path from 'path'
import { env } from '@huggingface/transformers'

/**
 * Point transformers.js at a WRITABLE model + cache directory. One function, called by whoever
 * hosts the pipeline, so there is a single place this contract is expressed.
 *
 * The library defaults `env.cacheDir` to `<its own module dir>/.cache`, which in a packaged app
 * resolves INSIDE the read-only app.asar. FileCache.put() then fails every write with ENOTDIR and
 * swallows it, so the ~23MB MiniLM download is never persisted and every embedding re-downloads it
 * — which surfaced as an "embeddings model timeout" on a fresh Windows install. The same asar is
 * read-only on macOS, so this must be the userData path on every platform.
 *
 * Takes modelsDir as an argument rather than calling modelsDir(): the embedding pipeline runs in a
 * worker thread, where Electron's app paths are unavailable, so the host resolves it and passes it.
 */
export function configureTransformersEnv(modelsDir: string, readOnly = false): void {
  env.localModelPath = modelsDir
  // The first run still downloads. OFFGRID_EMBEDDINGS_OFFLINE=1 (tests that do not test embeddings)
  // uses only what is already on disk, so a fresh temp folder fails fast instead of fetching ~23MB.
  env.allowRemoteModels = !readOnly && process.env.OFFGRID_EMBEDDINGS_OFFLINE !== '1'
  env.useFSCache = !readOnly
  env.cacheDir = path.join(modelsDir, '.cache')
}
