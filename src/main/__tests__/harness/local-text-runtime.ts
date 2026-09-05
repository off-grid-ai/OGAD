// Fake of the NATIVE local text runtime at its real boundary: the process that llama-server
// would be. Composition tests inject it as the ONE `localTextRuntime` port so the real
// workspace, adapters, and residency owners run unchanged over it. Readiness is a fact this
// runtime owns - load makes it ready, unload makes it not - exactly as the native engine does.
// Generation is a wire concern of the fake llama-server (fake-llama-server.ts); this fake owns
// lifecycle, state, and settings only, and says so when asked to generate.
import type { DesktopLocalTextRuntime } from '../../model-generation-adapters'

export interface FakeLocalTextRuntimeOptions {
  /** Start already loaded and ready (the engine was running before the app composed). */
  ready?: boolean
  /** Extra readiness facts merged into every `state()` answer (reasoning, contextLength). */
  state?: Partial<Omit<Awaited<ReturnType<DesktopLocalTextRuntime['state']>>, 'ready' | 'loaded'>>
  settings?: ReturnType<DesktopLocalTextRuntime['settings']>
  /** Runs before readiness flips on load; throw to fake a native startup failure. */
  onLoad?(): Promise<void> | void
  onUnload?(): Promise<void> | void
}

export interface FakeLocalTextRuntime {
  readonly runtime: DesktopLocalTextRuntime
  isReady(): boolean
  readonly loads: number
  readonly unloads: number
}

export function createFakeLocalTextRuntime(
  options: FakeLocalTextRuntimeOptions = {}
): FakeLocalTextRuntime {
  let ready = options.ready ?? false
  const counters = { loads: 0, unloads: 0 }
  const runtime: DesktopLocalTextRuntime = {
    async load() {
      await options.onLoad?.()
      counters.loads += 1
      ready = true
    },
    async unload() {
      await options.onUnload?.()
      counters.unloads += 1
      ready = false
    },
    state: async () => ({ ready, loaded: ready, ...options.state }),
    settings: () => options.settings ?? {},
    streamChatLocal: () =>
      Promise.reject(
        new Error('The fake local text runtime owns lifecycle only; it does not generate.')
      ) as ReturnType<DesktopLocalTextRuntime['streamChatLocal']>
  }
  return {
    runtime,
    isReady: () => ready,
    get loads() {
      return counters.loads
    },
    get unloads() {
      return counters.unloads
    }
  }
}
