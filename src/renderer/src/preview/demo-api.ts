// A stand-in for the preload bridge (`window.api`) with fixed demo answers. The renderer talks to the main
// process only through this bridge, so with it the real screens render in a plain browser: the translation
// preview (preview.html) and the app-boundary test harness both use it. It is UI only: nothing loads,
// nothing is saved, and any call not listed here answers `undefined`.

export const DEMO_PROJECTS = Array.from({ length: 12 }, (_, index) => {
  const suffix = index === 0 ? 'Alpha' : index === 1 ? 'Beta' : String(index + 1).padStart(2, '0')
  return {
    id: `project-${suffix.toLowerCase()}`,
    name: `Project ${suffix}`,
    description: '',
    systemPrompt: '',
    includeMemory: false,
    updatedAt: '2026-07-17T00:00:00.000Z'
  }
})

const eventSubscription = (): (() => void) => () => {}

export function createDemoApi(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const values: Record<string, unknown> = {
    isPro: false,
    // Documents in a chat (preload `documents`): none attached.
    documents: {
      list: async (): Promise<unknown[]> => [],
      setExcluded: async (): Promise<void> => undefined,
      onProgress: eventSubscription
    },
    platform: 'darwin',
    getPermissionStatus: async () => ({
      accessibility: true,
      screenRecording: true,
      localNetwork: true,
      allGranted: true
    }),
    checkModelStatus: async () => ({ downloaded: true, modelsDir: '/tmp/models' }),
    chatHealth: async () => ({ id: 'chat', label: 'Chat model', status: 'ready' }),
    systemHealth: async () => ({ ramGb: 16, components: [{ id: 'chat', status: 'ready' }] }),
    getStagedUpdateVersion: async () => null,
    meetingGetState: async () => ({
      recording: false,
      busy: false,
      platform: null,
      startedAt: 0,
      warnUntil: 0,
      error: ''
    }),
    getModelCatalog: async () => ({ kinds: ['text'], models: [] }),
    getInstalledModels: async () => [],
    getModelScanFolders: async () => [],
    getActiveModelIds: async () => [],
    listProjects: async () => DEMO_PROJECTS.map((project) => ({ ...project })),
    getRagConversations: async () => [],
    getSettings: async () => ({}),
    // main's 'mcp:list' always resolves an array of connectors (src/main/mcp-ipc.ts).
    mcpList: async () => [],
    // Search IPC returns arrays, including when there are no indexed sources or hits.
    searchFacets: async () => [],
    universalSearch: async () => [],
    onNewAction: eventSubscription,
    onUpdateDownloaded: eventSubscription,
    onNavigate: eventSubscription,
    // The app menu's View > Back / Forward (main/index.ts): its CmdOrCtrl+[ and CmdOrCtrl+]
    // accelerators send 'navigate:history'. A browser has no menu, so the keys stand in for it.
    onHistoryNavigate: (cb: (direction: 'back' | 'forward') => void): (() => void) => {
      const onKey = (event: KeyboardEvent): void => {
        if (!(event.metaKey || event.ctrlKey)) return
        if (event.key === '[') cb('back')
        else if (event.key === ']') cb('forward')
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    },
    onMeetingState: eventSubscription,
    onModelProgress: eventSubscription,
    proOn: eventSubscription,
    // Main answers 'rag:active-streams' with a list, empty when nothing is streaming. The generic
    // async default answers undefined, which the chat's reattach cannot iterate.
    getActiveRagStreams: async () => [],
    actions: {
      onGatePending: eventSubscription,
      onOutcome: eventSubscription,
      resolveGate: async () => undefined,
      undo: async () => ({ ok: true })
    },
    ...overrides
  }
  return new Proxy(values, {
    get(target, property: string) {
      if (property in target) return target[property]
      // A subscription is not a request, and standing in for one with an async stub hands the caller a
      // Promise where it expects an unsubscribe function. ProjectsScreen keeps the return value of
      // api.onRagConversationsChanged and calls it on unmount, so the async default made teardown throw
      // "offChanged is not a function" - during React's cleanup, which surfaced as an unrelated
      // navigation test failing on a screen it had already left.
      //
      // Every onX in the preload returns () => void synchronously, so the default has to as well. Named
      // by the same on* convention the preload uses, which is what makes one rule cover all of them
      // instead of listing each new subscription here.
      if (/^on[A-Z]/.test(property) || property === 'proOn') return eventSubscription
      return async () => undefined
    }
  })
}
