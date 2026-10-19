import { describe, expect, it } from 'vitest'
import { createSettingsStore, type SettingsStoreDeps } from '../bridge-settings-store'
import type { ConnectorsSettings, TextSettings } from '../bridge-settings'

// The desktop's own functions, faked: what a paired browser reads must be what Settings here
// shows, and what it writes must go through the same setters.

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- test fixture
function fakeDesktop() {
  const task = {
    modelStrategy: 'same_as_chat',
    context: 'auto',
    screenshotSize: 'large',
    visualHistoryFrames: 1,
    checkpointInterval: 8,
    groundingModelId: 'kept-on-desktop' as string | null,
    decisionModelId: null as string | null
  }
  const state = {
    web: { ...task, browserTarget: 'in_app' as 'in_app' | 'default_browser' },
    computer: { ...task, showPictureInPicture: false, enabledRails: ['vision'] },
    app: { toolsEnabled: true, ttsVoice: 'af_heart', imgSeed: '7' } as Record<string, unknown>,
    tools: [
      { name: 'get_weather', description: 'Weather', enabled: true },
      { name: 'send_email', description: 'Email', enabled: false }
    ],
    connectors: [
      { id: 1, name: 'Notes', url: 'https://mcp.test/notes', enabled: 1 },
      { id: 2, name: 'Local script', url: null, enabled: 1 }
    ] as Array<{ id: number; name: string; url: string | null; enabled: number; status?: string }>,
    remote: { activeServerId: null as string | null, textOnRemote: false },
    servers: [
      {
        id: 'lab',
        name: 'Lab',
        endpoint: 'https://lab.example.test:8443/v1?key=secret',
        model: 'qwen-32b',
        roleModels: { grounding: 'ui-tars', decision: 'decider' },
        modelCatalog: [{ id: 'qwen-32b', name: 'Qwen 32B' }]
      },
      { id: 'off', name: 'Off', endpoint: 'https://off.test', model: 'x', enabled: false }
    ],
    calls: [] as string[]
  }
  const deps: SettingsStoreDeps = {
    text: async () => ({ activeModelId: 'chat', availability: { vision: true, agent: true } }),
    web: () => state.web,
    setWeb: (next) => void (state.web = next as typeof state.web),
    computer: () => state.computer,
    setComputer: (next) => void (state.computer = next as typeof state.computer),
    remote: () => ({ ...state.remote, servers: state.servers }),
    useRemote: (id) => {
      state.remote = { activeServerId: id, textOnRemote: true }
      return true
    },
    remoteOff: () => void (state.remote = { activeServerId: null, textOnRemote: false }),
    taskModels: async () => ({
      catalog: [
        { id: 'grounder-7b', name: 'Grounder 7B', kind: 'computer_use' },
        { id: 'decider-2b', name: 'Decider 2B', kind: 'computer_use', tags: ['Decision'] },
        { id: 'not-installed', name: 'Missing', kind: 'computer_use' },
        { id: 'chat', name: 'Chat', kind: 'text' }
      ],
      installed: ['grounder-7b', 'decider-2b', 'chat'],
      activeGrounder: 'grounder-7b'
    }),
    setLocalGrounder: async (id) => void state.calls.push(`grounder ${id}`),
    appSettings: () => state.app,
    saveSetting: (key, value) => void (state.app = { ...state.app, [key]: value }),
    listTools: () => state.tools,
    setToolEnabled: (name, enabled) => {
      state.tools = state.tools.map((t) => (t.name === name ? { ...t, enabled } : t))
    },
    listConnectors: () => state.connectors,
    addConnector: (c) => {
      state.calls.push(`add ${c.name} ${c.transport} ${c.url}`)
    },
    setConnectorEnabled: (id, enabled) => void state.calls.push(`enable ${id} ${enabled}`),
    removeConnector: (id) => void state.calls.push(`remove ${id}`),
    activeImageModel: () => 'sdxl',
    imageParams: (_model, store) => ({
      size: 1024,
      steps: (store as Record<string, { steps?: number }> | undefined)?.sdxl?.steps ?? 28,
      cfgScale: 7
    }),
    setImageParam: (store, model, key, value) => ({
      ...(store as object),
      [model]: { ...((store as Record<string, object> | undefined)?.[model] ?? {}), [key]: value }
    }),
    transcription: async () => ({
      language: 'en',
      languages: [
        { code: 'auto', label: 'Detect' },
        { code: 'en', label: 'English' }
      ]
    })
  }
  return { state, deps, store: createSettingsStore(deps) }
}

describe('a paired browser’s view of the desktop settings', () => {
  it('reads Tasks without anything the browser may not set', async () => {
    const { store } = fakeDesktop()
    const tasks = (await store.read('tasks')) as unknown as Record<string, Record<string, unknown>>
    expect(tasks.web).toEqual({
      decisionModelId: '',
      modelStrategy: 'same_as_chat',
      context: 'auto',
      screenshotSize: 'large',
      visualHistoryFrames: 1,
      checkpointInterval: 8,
      browserTarget: 'in_app'
    })
    expect(tasks.computer).toMatchObject({ showPictureInPicture: false, enabledRails: ['vision'] })
    expect(JSON.stringify(tasks)).not.toContain('groundingModelId')
  })

  it('offers installed and remote role models for grounding and decisions', async () => {
    const { store } = fakeDesktop()
    const tasks = await store.read('tasks')
    expect(tasks).toMatchObject({
      grounding: 'kept-on-desktop',
      groundingChoices: [
        { id: 'grounder-7b', label: 'Grounder 7B' },
        // The model's name, never the server's: the server rides beside it.
        { id: expect.stringContaining('ui-tars'), label: 'Ui tars', server: 'Lab' }
      ],
      decisionChoices: [
        { id: 'decider-2b', label: 'Decider 2B' },
        { id: expect.stringContaining('decider'), label: 'Decider', server: 'Lab' }
      ]
    })
  })

  it('sets only offered models; a local grounder also becomes the active one', async () => {
    const { store, state } = fakeDesktop()
    await store.write('tasks', { grounding: 'not-installed', web: { decisionModelId: 'nope' } })
    expect(state.computer.groundingModelId).toBe('kept-on-desktop')
    expect(state.web.decisionModelId).toBeNull()
    await store.write('tasks', { grounding: 'grounder-7b', web: { decisionModelId: 'decider-2b' } })
    expect(state.calls).toEqual(['grounder grounder-7b'])
    expect(state.computer.groundingModelId).toBe('grounder-7b')
    expect(state.web.decisionModelId).toBe('decider-2b')
    await store.write('tasks', { web: { decisionModelId: '' } })
    expect(state.web.decisionModelId).toBeNull()
    const remote = (await store.read('tasks')) as unknown as { groundingChoices: { id: string }[] }
    const remoteId = remote.groundingChoices[1]!.id
    await store.write('tasks', { grounding: remoteId })
    expect(state.calls).toEqual(['grounder grounder-7b'])
    expect(state.computer.groundingModelId).toBe(remoteId)
  })

  it('shows remote servers by name and host only, and switches between them', async () => {
    const { store, state } = fakeDesktop()
    expect(await store.read('remote')).toEqual({
      active: false,
      activeServerId: null,
      servers: [
        {
          id: 'lab',
          name: 'Lab',
          host: 'lab.example.test:8443',
          model: 'Qwen 32B',
          available: true
        }
      ]
    })
    await store.write('remote', { use: 'made-up' })
    expect(state.remote.textOnRemote).toBe(false)
    await store.write('remote', { use: 'lab' })
    expect(await store.read('remote')).toMatchObject({ active: true, activeServerId: 'lab' })
    await store.write('remote', { off: true })
    expect(await store.read('remote')).toMatchObject({ active: false, activeServerId: null })
    expect(JSON.stringify(await store.read('remote'))).not.toContain('secret')
  })

  it('writes Tasks through the setters, keeping what the browser did not send', async () => {
    const { store, state } = fakeDesktop()
    await store.write('tasks', { web: { browserTarget: 'default_browser' } })
    expect(state.web).toMatchObject({
      browserTarget: 'default_browser',
      groundingModelId: 'kept-on-desktop'
    })
    await store.write('tasks', { computer: { enabledRails: ['ax'], showPictureInPicture: true } })
    expect(state.computer).toMatchObject({ enabledRails: ['ax'], showPictureInPicture: true })
  })

  it('switches tools, and ignores a tool the desktop does not have', async () => {
    const { store, state } = fakeDesktop()
    await store.write('tools', { enabled: false, tool: { name: 'send_email', enabled: true } })
    await store.write('tools', { tool: { name: 'made_up', enabled: false } })
    expect(state.app.toolsEnabled).toBe(false)
    expect(await store.read('tools')).toEqual({
      enabled: false,
      tools: [
        { name: 'get_weather', description: 'Weather', enabled: true },
        { name: 'send_email', description: 'Email', enabled: true }
      ]
    })
  })

  it('shows only HTTP connectors, and acts only on ones it lists', async () => {
    const { store, state } = fakeDesktop()
    expect(await store.read('connectors')).toEqual({
      connectors: [{ id: '1', name: 'Notes', url: 'https://mcp.test/notes', enabled: true }]
    })
    await store.write('connectors', { add: { name: 'Docs', url: 'https://docs.test/mcp' } })
    await store.write('connectors', { setEnabled: { id: '1', enabled: false } })
    await store.write('connectors', { setEnabled: { id: '2', enabled: false } })
    await store.write('connectors', { remove: '2' })
    await store.write('connectors', { remove: '1' })
    expect(state.calls).toEqual([
      'add Docs http https://docs.test/mcp',
      'enable 1 false',
      'remove 1'
    ])
  })

  it('shows an account with what it can read and how it stands', async () => {
    const { store, state, deps } = fakeDesktop()
    state.connectors = [
      ...state.connectors,
      {
        id: 3,
        name: 'Google (work@example.com)',
        url: 'https://gmailmcp.googleapis.com/mcp/v1?offgrid-services=workspace',
        enabled: 1,
        status: 'error'
      }
    ]
    deps.accountAccess = (id) => (id === 3 ? { services: ['Gmail'], missing: ['Drive'] } : null)
    expect(((await store.read('connectors')) as ConnectorsSettings).connectors).toEqual([
      { id: '1', name: 'Notes', url: 'https://mcp.test/notes', enabled: true },
      expect.objectContaining({
        id: '3',
        liveOnly: true,
        health: 'needs-sign-in',
        services: ['Gmail'],
        missing: ['Drive']
      })
    ])
  })

  it('reads and writes Image, Transcription and Voice as the desktop keys them', async () => {
    const { store, state } = fakeDesktop()
    expect(await store.read('image')).toEqual({
      model: 'sdxl',
      size: 1024,
      steps: 28,
      cfgScale: 7,
      seed: '7',
      negative: '',
      enhance: true
    })
    await store.write('image', { steps: 12, negative: 'blurry', enhance: false })
    expect(state.app).toMatchObject({
      imageParams: { sdxl: { steps: 12 } },
      imgNegative: 'blurry',
      enhanceImagePrompts: false
    })
    expect((await store.read('image')) as { steps: number }).toMatchObject({ steps: 12 })

    expect(await store.read('transcription')).toEqual({
      language: 'en',
      languages: [
        { code: 'auto', label: 'Detect' },
        { code: 'en', label: 'English' }
      ]
    })
    await store.write('transcription', { language: 'auto' })
    expect(state.app.sttLanguage).toBe('auto')

    await store.write('voice', { voice: 'bm_george', ttsEnabled: false, speed: 1.5 })
    expect(await store.read('voice')).toEqual({ ttsEnabled: false, voice: 'bm_george', speed: 1.5 })
  })
  it('returns Desktop text options and corrected settings after a write', async () => {
    const { deps, store } = fakeDesktop()
    let settings: TextSettings = { ctxSize: 4096, maxTokens: 0, reasoningBudget: 8192 }
    deps.text = async () => ({
      ...settings,
      supportsMtp: false,
      compatibleDraftModels: [],
      compatibleDflashModels: ['draft.gguf']
    })
    const taskModels = deps.taskModels
    deps.taskModels = async () => ({
      ...(await taskModels()),
      companionStatus: { chat: { dflashInstalled: true, dflashFile: 'draft.gguf' } }
    })
    deps.setText = async (patch) => {
      settings = { ...settings, ...patch }
    }
    await store.write('text', { maxTokens: 1024, reasoningBudget: 32768 })
    expect(await store.read('text')).toMatchObject({
      maxTokens: 1024,
      reasoningBudget: 1024,
      options: {
        thinkingBudgets: [0, 512, 1024],
        draftModels: [],
        dflashModels: [{ id: 'draft.gguf', label: 'Chat · DFlash' }]
      }
    })
    await store.write('text', { speculativeDecoding: 'dflash', draftModel: 'wrong.gguf' })
    expect(await store.read('text')).toMatchObject({
      speculativeDecoding: 'dflash',
      draftModel: 'draft.gguf'
    })
    await store.write('text', { speculativeDecoding: 'draft' })
    expect(await store.read('text')).toMatchObject({ speculativeDecoding: 'off' })
  })

  it('keeps the current strategy when the requested strategy has no models', async () => {
    const { store, deps, state } = fakeDesktop()
    deps.taskModels = async () => ({ catalog: [], installed: [], activeGrounder: null })
    deps.remote = () => ({ activeServerId: null, textOnRemote: false, servers: [] })
    await store.write('tasks', { web: { modelStrategy: 'decision_plus_specialist' } })
    expect(state.web.modelStrategy).toBe('same_as_chat')
  })
})
