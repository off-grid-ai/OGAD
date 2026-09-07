/**
 * Regression guard for the "embeddings model timeout" bug (Windows, fresh install).
 *
 * transformers.js defaults `env.cacheDir` to `<its own module dir>/.cache`, which in
 * a packaged app resolves INSIDE the read-only app.asar. FileCache.put() then fails
 * every write with ENOTDIR (asar is a file, not a dir) and swallows it — so the
 * ~23MB MiniLM download is NEVER persisted and every embedding re-downloads it from
 * HuggingFace. On a slow link that repeated full download surfaces as a "timeout".
 * (Confirmed on a Windows box: download + onnxruntime + network all fine; 8 ENOTDIR
 * warnings from FileCache.put per operation; nothing cached to disk.)
 *
 * The fix pins `env.cacheDir` to a writable dir under the userData models dir. This
 * test fails if that assignment regresses back to the library default. It also guards
 * the cross-platform contract: the same asar is read-only on macOS, so the cache dir
 * must be the writable userData path on BOTH platforms, never inside the package.
 */
import { describe, it, expect } from 'vitest'
import path from 'path'
import os from 'os'

describe('embeddings on-disk cache is a writable dir (not inside app.asar / the package)', () => {
  it('points transformers cacheDir at the userData models dir', async () => {
    // The pipeline now runs in a worker thread (embeddings-worker.ts), which cannot reach
    // Electron's app paths — so the writable-dir contract lives in one function that takes the
    // directory, and the worker calls it on startup. Exercise that function directly: it IS the
    // assignment this guard exists to protect.
    const dataDir = path.join(os.tmpdir(), 'offgrid-embed-cachedir-test')
    const modelsDir = path.join(dataDir, 'models')

    const { env } = await import('@xenova/transformers')
    const { configureTransformersEnv } = await import('../embeddings-env')
    configureTransformersEnv(modelsDir)
    expect(env.cacheDir).toBe(path.join(modelsDir, '.cache'))
    // The download target and the local-model lookup must share the writable dir.
    expect(env.localModelPath).toBe(modelsDir)
    // Must NOT be the library default, which lives inside the (read-only-when-packaged)
    // @xenova/transformers package folder.
    expect(env.cacheDir).not.toMatch(/@xenova[\\/]transformers/)
    // Still allow the first-run download (offline bundling is a separate decision).
    expect(env.allowRemoteModels).toBe(true)
  })
})
