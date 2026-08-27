import path from 'path'
import { env } from '@xenova/transformers'

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
export function configureTransformersEnv(modelsDir: string): void {
  env.localModelPath = modelsDir
  env.allowRemoteModels = true // first run still downloads
  env.cacheDir = path.join(modelsDir, '.cache')
}
