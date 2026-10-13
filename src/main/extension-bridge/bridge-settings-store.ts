import {
  thinkingBudgetOptions,
  speculativeOptions,
  budgetChange,
  speculativePatch,
  installedDraftModels,
  type DraftCatalogModel,
  type DraftCompanionStatus
} from '../../shared/text-settings-rules'
import { playbackSpeed } from '../../shared/voice-speed'
import {
  TASK_CONTEXTS,
  SCREENSHOT_SIZES,
  VISUAL_HISTORY,
  CHECKPOINTS,
  RAILS,
  BROWSER_TARGETS
} from './bridge-settings'
// A paired browser's view of the desktop's settings (sealed settings.get / settings.set). The
// browser sees and changes the same values as Settings here, through the same functions:
// Remote, Tasks, Tools, Connectors, Image, Transcription and Voice. The patch arriving here has
// already been checked by bridge-settings.ts (listed keys, types, bounds); the setters below
// normalise it as they do for the desktop's own screen.
//
// Pure apart from the injected desktop functions (bridge-electron.ts wires the real ones),
// so it is tested without Electron or a database.

import type {
  SettingsBySection,
  SettingsSection,
  TaskOptions,
  TextSettings
} from './bridge-settings'
import { parseRemoteVisionModelId } from '../../shared/remote-vision-server'
import {
  remoteView,
  taskModelChoices,
  taskStrategyOptions,
  modelsByTab,
  type SavedServer
} from './bridge-task-models'

type Patch = Record<string, unknown>

type Decides = { decisionModelId: string | null }

export interface SettingsStoreDeps {
  text?(): Promise<
    TextSettings & {
      supportsMtp?: boolean
      compatibleDraftModels?: string[]
      compatibleDflashModels?: string[]
    }
  >
  setText?(patch: TextSettings): Promise<void>
  activeIds?(): Promise<string[]>

  web(): TaskOptions & Decides & { browserTarget: 'in_app' | 'default_browser' }
  setWeb(next: unknown): void
  computer(): TaskOptions &
    Decides & {
      showPictureInPicture: boolean
      enabledRails: string[]
      groundingModelId: string | null
    }
  setComputer(next: unknown): void
  remote(): { activeServerId: string | null; textOnRemote: boolean; servers: SavedServer[] }
  /** Runs chat on a saved server's text model; false when it has none or is switched off. */
  useRemote(serverId: string): boolean
  remoteOff(): void
  /** The model catalog, what is installed, and the active local grounding model. */
  taskModels(): Promise<{
    catalog: Record<string, unknown>[]
    installed: string[]
    activeGrounder: string | null
    activeChatId?: string | null
    companionStatus?: DraftCompanionStatus
  }>
  setLocalGrounder(modelId: string): Promise<void>
  appSettings(): Record<string, unknown>
  saveSetting(key: string, value: unknown): void
  listTools(): { name: string; description: string; enabled: boolean }[]
  setToolEnabled(name: string, enabled: boolean): void
  listConnectors(): {
    id: number
    name: string
    url: string | null
    enabled: number
    status?: string
  }[]
  /** An account's access, for accounts (live-only connectors); null for a plain connector. */
  accountAccess?(id: number): { services: string[]; missing: string[] } | null
  addConnector(c: { name: string; transport: 'http'; url: string }): void
  setConnectorEnabled(id: number, enabled: boolean): void
  removeConnector(id: number): void
  activeImageModel(): string | null
  imageParams(model: string, store: unknown): { size: number; steps: number; cfgScale: number }
  setImageParam(
    store: unknown,
    model: string,
    key: 'size' | 'steps' | 'cfgScale',
    value: number
  ): unknown
  transcription(): Promise<{
    language: string
    languages: readonly { code: string; label: string }[]
  }>
}

const TASK_KEYS = [
  'modelStrategy',
  'context',
  'screenshotSize',
  'visualHistoryFrames',
  'checkpointInterval'
] as const

function taskOptions(s: TaskOptions): TaskOptions {
  return {
    modelStrategy: s.modelStrategy,
    context: s.context,
    screenshotSize: s.screenshotSize,
    visualHistoryFrames: s.visualHistoryFrames,
    checkpointInterval: s.checkpointInterval
  }
}

const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback)

export function createSettingsStore(deps: SettingsStoreDeps): {
  read(section: SettingsSection): Promise<SettingsBySection[SettingsSection]>
  write(section: SettingsSection, patch: Patch): Promise<void>
} {
  const readers: {
    [S in SettingsSection]: () => Promise<SettingsBySection[S]> | SettingsBySection[S]
  } = {
    text: async () => {
      const settings = (await deps.text?.()) ?? {}
      const models = await deps.taskModels()
      const {
        supportsMtp: _supportsMtp,
        compatibleDraftModels,
        compatibleDflashModels,
        ...safe
      } = settings
      const drafts = installedDraftModels(
        models.catalog as unknown as DraftCatalogModel[],
        models.activeChatId ?? null,
        models.companionStatus ?? {},
        compatibleDraftModels ?? [],
        compatibleDflashModels ?? []
      )
      return {
        ...safe,
        options: {
          thinkingBudgets: thinkingBudgetOptions(settings),
          speculativeModes: speculativeOptions(settings),
          draftModels: drafts.draft.map((option) => ({ id: option.value, label: option.label })),
          dflashModels: drafts.dflash.map((option) => ({ id: option.value, label: option.label }))
        },
        modelsByTab: modelsByTab(models.catalog, models.installed, (await deps.activeIds?.()) ?? [])
      }
    },
    remote: () => {
      const r = deps.remote()
      return remoteView(r.servers, r.activeServerId, r.textOnRemote)
    },
    tasks: async () => {
      const web = deps.web()
      const computer = deps.computer()
      const models = await deps.taskModels()
      const choices = taskModelChoices({ ...models, servers: deps.remote().servers })
      const text = await deps.text?.()
      const reasoners = text?.activeModelId
        ? [{ id: text.activeModelId, label: text.activeModelId }]
        : []
      return {
        strategies: taskStrategyOptions(choices, reasoners),
        options: {
          contexts: TASK_CONTEXTS,
          screenshotSizes: SCREENSHOT_SIZES,
          visualHistory: VISUAL_HISTORY,
          checkpoints: CHECKPOINTS,
          rails: RAILS,
          browserTargets: BROWSER_TARGETS
        },
        grounding: computer.groundingModelId ?? models.activeGrounder ?? '',
        groundingChoices: choices.grounding,
        decisionChoices: choices.decision,
        web: {
          ...taskOptions(web),
          browserTarget: web.browserTarget,
          decisionModelId: web.decisionModelId ?? ''
        },
        computer: {
          ...taskOptions(computer),
          showPictureInPicture: computer.showPictureInPicture,
          enabledRails: [...computer.enabledRails],
          decisionModelId: computer.decisionModelId ?? ''
        }
      }
    },
    tools: () => ({
      enabled: deps.appSettings().toolsEnabled !== false,
      tools: deps
        .listTools()
        .map((t) => ({ name: t.name, description: t.description, enabled: t.enabled }))
    }),
    connectors: () => ({
      // Only HTTP connectors are shown: a local command's path and arguments stay on the desktop.
      connectors: deps
        .listConnectors()
        .filter((c) => typeof c.url === 'string' && c.url)
        .map((c) => {
          const access = deps.accountAccess?.(c.id) ?? null
          return {
            id: String(c.id),
            name: c.name,
            url: c.url as string,
            enabled: c.enabled === 1,
            ...(access
              ? {
                  liveOnly: true,
                  health:
                    c.status === 'error'
                      ? ('needs-sign-in' as const)
                      : c.enabled === 1
                        ? ('connected' as const)
                        : ('off' as const),
                  services: access.services,
                  missing: access.missing
                }
              : {})
          }
        })
    }),
    image: () => {
      const settings = deps.appSettings()
      const model = deps.activeImageModel()
      const params = model
        ? deps.imageParams(model, settings.imageParams)
        : { size: 512, steps: 28, cfgScale: 7 }
      return {
        model,
        ...params,
        seed: str(settings.imgSeed, ''),
        negative: str(settings.imgNegative, ''),
        enhance: settings.enhanceImagePrompts !== false
      }
    },
    transcription: async () => {
      const info = await deps.transcription()
      return {
        language: info.language,
        languages: info.languages.map((l) => ({ code: l.code, label: l.label }))
      }
    },
    voice: () => {
      const settings = deps.appSettings()
      return {
        ttsEnabled: settings.ttsEnabled !== false,
        voice: str(settings.ttsVoice, 'af_heart'),
        speed: playbackSpeed(settings.ttsSpeed)
      }
    }
  }

  const writers: Record<SettingsSection, (patch: Patch) => Promise<void> | void> = {
    text: async (p) => {
      if (!deps.setText) return
      const settings = (await deps.text?.()) ?? {}
      await deps.setText({ ...p, ...budgetChange(settings, speculativePatch(settings, p)) })
    },
    remote: (p) => {
      if (p.off === true) {
        deps.remoteOff()
      } else if (typeof p.use === 'string' && deps.remote().servers.some((s) => s.id === p.use)) {
        deps.useRemote(p.use)
      }
    },
    tasks: async (p) => {
      const models = await deps.taskModels()
      const choices = taskModelChoices({ ...models, servers: deps.remote().servers })
      const text = await deps.text?.()
      const strategies = taskStrategyOptions(
        choices,
        text?.activeModelId ? [{ id: text.activeModelId, label: text.activeModelId }] : []
      )
      const validTask = (raw: unknown, extra: readonly string[]): Patch => {
        const patch = pickTask(raw, extra)
        if (
          patch.modelStrategy &&
          !strategies.some((option) => option.value === patch.modelStrategy && option.available)
        )
          delete patch.modelStrategy
        return patch
      }
      const decider = (raw: unknown): Patch => decisionPatch(raw, choices.decision)
      if (p.web) {
        deps.setWeb({ ...deps.web(), ...validTask(p.web, ['browserTarget']), ...decider(p.web) })
      }
      if (p.computer) {
        deps.setComputer({
          ...deps.computer(),
          ...validTask(p.computer, ['showPictureInPicture', 'enabledRails']),
          ...decider(p.computer)
        })
      }
      const grounding = choices.grounding.find((c) => c.id === p.grounding)
      if (grounding) {
        // A local grounder is also the active Computer Use model, as Settings > Tasks does it.
        if (!parseRemoteVisionModelId(grounding.id)) await deps.setLocalGrounder(grounding.id)
        deps.setComputer({ ...deps.computer(), groundingModelId: grounding.id })
      }
    },
    tools: (p) => {
      if (typeof p.enabled === 'boolean') deps.saveSetting('toolsEnabled', p.enabled)
      const tool = p.tool as { name: string; enabled: boolean } | undefined
      if (tool && deps.listTools().some((t) => t.name === tool.name)) {
        deps.setToolEnabled(tool.name, tool.enabled)
      }
    },
    connectors: (p) => {
      const add = p.add as { name: string; url: string } | undefined
      if (add) deps.addConnector({ name: add.name, transport: 'http', url: add.url })
      const toggle = p.setEnabled as { id: string; enabled: boolean } | undefined
      if (toggle && known(toggle.id)) deps.setConnectorEnabled(Number(toggle.id), toggle.enabled)
      if (typeof p.remove === 'string' && known(p.remove)) deps.removeConnector(Number(p.remove))
    },
    image: (p) => {
      const model = deps.activeImageModel()
      let store = deps.appSettings().imageParams
      for (const key of ['size', 'steps', 'cfgScale'] as const) {
        if (model && typeof p[key] === 'number')
          store = deps.setImageParam(store, model, key, p[key])
      }
      if (store !== deps.appSettings().imageParams) deps.saveSetting('imageParams', store)
      if (typeof p.seed === 'string') deps.saveSetting('imgSeed', p.seed)
      if (typeof p.negative === 'string') deps.saveSetting('imgNegative', p.negative)
      if (typeof p.enhance === 'boolean') deps.saveSetting('enhanceImagePrompts', p.enhance)
    },
    transcription: (p) => {
      if (typeof p.language === 'string') deps.saveSetting('sttLanguage', p.language)
    },
    voice: (p) => {
      if (typeof p.ttsEnabled === 'boolean') deps.saveSetting('ttsEnabled', p.ttsEnabled)
      if (typeof p.voice === 'string') deps.saveSetting('ttsVoice', p.voice)
      if (typeof p.speed === 'number') deps.saveSetting('ttsSpeed', p.speed)
    }
  }

  // Connector ids arrive as strings; only an id the desktop lists, and only an HTTP one, counts.
  const known = (id: string): boolean =>
    deps.listConnectors().some((c) => String(c.id) === id && typeof c.url === 'string' && c.url)

  return {
    read: async (section) => readers[section](),
    async write(section, patch) {
      await writers[section](patch)
    }
  }
}

/** A decision model the desktop offers, or '' for the default; anything else is dropped. */
function decisionPatch(raw: unknown, choices: readonly { id: string }[]): Patch {
  const id = ((raw ?? {}) as Patch).decisionModelId
  if (id === '') return { decisionModelId: null }
  return choices.some((c) => c.id === id) ? { decisionModelId: id } : {}
}

function pickTask(raw: unknown, extra: readonly string[]): Patch {
  const p = (raw ?? {}) as Patch
  const out: Patch = {}
  for (const key of [...TASK_KEYS, ...extra]) {
    if (Object.hasOwn(p, key)) out[key] = p[key]
  }
  return out
}
