import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { persistToggle } from '@renderer/lib/persist-toggle'
import {
  DEFAULT_CTX_SIZE,
  DEFAULT_MAX_TOOL_CALLS,
  MAX_MAX_TOOL_CALLS,
  MAX_TOKENS_AUTO,
  MIN_MAX_TOOL_CALLS,
  MIN_CAPTURE_CTX_SIZE
} from '@offgrid/core/shared/llm-defaults'
import { REASONING_BUDGET_AUTO, reasoningBudgetLabel, optionsWithinCeiling } from '@offgrid/models'
import { gpuLayersHint, type EngineAccelerator } from '@offgrid/core/shared/engine-accelerator'
import {
  contextWindowOptions,
  contextWindowHint,
  recommendedContextWindow
} from '@renderer/lib/ctx-options'
import { formatContextWindow, resolveActiveTextModel } from '@renderer/lib/model-summary'
import {
  invalidateDisplaySettings,
  invalidateLlmSettings
} from '@renderer/lib/settings-invalidation'
import {
  openActiveModelsPanel,
  type ModelSettingsPanelTab as Tab
} from '@renderer/lib/model-settings-panel'
import { ImageSettingsTab } from './ImageSettingsTab'
import { SidePanel } from './SidePanel'
import { VoiceSettingsTab } from './VoiceSettingsTab'
import { BestSettingsCard } from './BestSettingsCard'
import { RemoteVisionSettingsTab } from './RemoteVisionSettingsTab'
import { SettingsRow as Row } from './SettingsRow'
import { SettingsSelect } from './SettingsSelect'
import { Button } from '@offgrid/operator-ui/operator/coss/button'
import { Input } from '@offgrid/operator-ui/operator/coss/input'
import { Textarea } from '@offgrid/operator-ui/operator/coss/textarea'
import Counter from '@offgrid/operator-ui/operator/bits/counter'
import { Segmented } from '@offgrid/operator-ui/operator/segmented'
import ElasticSlider from '@offgrid/operator-ui/operator/bits/elastic-slider'
import { Switch } from '@offgrid/operator-ui/operator/animate/switch'
import { TextMorph } from '@offgrid/operator-ui/operator/motion/text-morph'
import { AnimatedGroup } from '@offgrid/operator-ui/operator/motion/animated-group'
import { Stat, StatLabel, StatValue } from '@offgrid/operator-ui/operator/dice/stat'
import { Empty, EmptyDescription, EmptyMedia } from '@offgrid/operator-ui/operator/coss/empty'
import { ListRow } from '@offgrid/operator-ui/operator/list-row'
import { AutoHeight, SettingRow } from '@offgrid/operator-ui/operator/presence'
import { BackendPreferencesSection } from './ProcessingControls'
import { useReplySound } from '../lib/reply-sound'
import { SettingsSection } from './SettingsSection'
import { groupConnectors } from '../../../shared/connector-groups'
import type { SpeechLanguage } from '@offgrid/speech'
import {
  ArrowCounterClockwise,
  CaretRight,
  Flame,
  Minus,
  Plugs,
  Plus,
  Snowflake,
  Trash,
  Wrench,
  X
} from '@phosphor-icons/react'
import { IconTip } from './IconTip'
import { getSlot, SLOTS } from '@renderer/bootstrap/slotRegistry'

import {
  budgetChange,
  thinkingBudgetOptions,
  speculativeOptions,
  speculativePatch,
  type SpeculativeMode,
  installedDraftModels,
  type DraftModelOption
} from '../../../shared/text-settings-rules'

const MAX_OUTPUT_AUTO = MAX_TOKENS_AUTO
// The values THIS picker offers. The nesting rule they obey is shared (@offgrid/models); which
// discrete steps to show is a desktop rendering choice, and OGAM uses sliders instead.
const MAX_OUTPUT_OPTIONS = [2048, 4096, 8192, 16384, 32768]

// Right-side Settings panel (same pattern as SkillsPanel/ArtifactCanvas).
// Tabs: Model (inference params), Image, Voice (Kokoro TTS), Tools (built-in, read-only),
// Connectors (MCP servers — the user's reusable tool library). All on-device.
type KvCacheType = 'f16' | 'q8_0' | 'q4_0'
type SpeculativeDecodingMode = 'off' | 'ngram' | 'mtp' | 'draft' | 'dflash'
type LlmSettings = {
  temperature?: number
  ctxSize?: number
  topP?: number
  topK?: number
  minP?: number
  repeatPenalty?: number
  maxTokens?: number
  maxToolCalls?: number
  reasoningBudget?: number
  systemPrompt?: string
  kvCacheType?: KvCacheType
  flashAttn?: boolean
  gpuLayers?: number
  threads?: number
  batchSize?: number
  speculativeDecoding?: SpeculativeDecodingMode
  speculativeDraftMax?: number
  draftModel?: string
  supportsMtp?: boolean
  compatibleDraftModels?: string[]
  compatibleDflashModels?: string[]
  effectiveCtxSize?: number // reported by the backend (RAM-clamped); read-only
  modelMaxCtx?: number | null // the model's TRAINED window (GGUF); read-only, bounds the picker
  gpuAccelerator?: EngineAccelerator | null // the engine the backend actually spawned; read-only
}
type Connector = {
  id: number
  name: string
  url?: string | null
  transport?: string
  enabled?: number | boolean
}

type ToolSetting = { name: string; description: string; enabled?: boolean }

const TOOL_GROUPS = [
  {
    label: 'God',
    matches: (name: string): boolean => ['computer_use', 'web_use'].includes(name)
  },
  {
    label: 'Calendar',
    matches: (name: string): boolean => name.startsWith('calendar_')
  },
  {
    label: 'Reminders',
    matches: (name: string): boolean => name.startsWith('reminders_')
  },
  {
    label: 'Web',
    matches: (name: string): boolean =>
      ['web_search', 'brave_search', 'read_url', 'open_url'].includes(name)
  },
  {
    label: 'Memory',
    matches: (name: string): boolean =>
      ['read_screen', 'search_memory', 'search_knowledge_base', 'search_meetings'].includes(name)
  },
  {
    label: 'Communication',
    matches: (name: string): boolean =>
      name.startsWith('contacts_') || name.startsWith('messages_') || name.startsWith('mail_')
  },
  {
    label: 'Device',
    matches: (name: string): boolean => name === 'get_current_location'
  },
  {
    label: 'Media',
    matches: (name: string): boolean => name === 'generate_image'
  },
  {
    label: 'Utilities',
    matches: (name: string): boolean => ['calculator', 'get_datetime'].includes(name)
  }
] as const

function groupTools(tools: ToolSetting[]): { label: string; tools: ToolSetting[] }[] {
  const groups = TOOL_GROUPS.map((group) => ({
    label: group.label,
    tools: tools.filter((tool) => group.matches(tool.name))
  })).filter((group) => group.tools.length > 0)
  const known = new Set(groups.flatMap((group) => group.tools.map((tool) => tool.name)))
  const other = tools.filter((tool) => !known.has(tool.name))
  return other.length > 0 ? [...groups, { label: 'Other', tools: other }] : groups
}

type TranscriptionInfo = {
  engine: 'whisper' | 'parakeet' | 'whisper-resident' | 'remote'
  modelId: string | null
  label: string
  language: string
  languages: SpeechLanguage[]
  options: { id: string | null; name: string; active: boolean }[]
}

const DEFAULT_TRANSCRIPTION_MODEL = '__default-transcription-model__'

const CTX_OPTIONS = [4096, 8192, 16384, 32768, 65536, 131072]
// Defaults mirror the backend's LLMService field defaults (for "Reset to defaults").
const DEFAULTS: LlmSettings = {
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  minP: 0.05,
  repeatPenalty: 1.1,
  maxTokens: MAX_TOKENS_AUTO,
  maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
  ctxSize: DEFAULT_CTX_SIZE,
  systemPrompt: '',
  kvCacheType: 'f16',
  flashAttn: false,
  gpuLayers: 99,
  threads: 0,
  batchSize: 512,
  speculativeDecoding: 'off',
  draftModel: ''
}

/**
 * A slider that drafts while it moves and saves when it loses focus, like the range inputs it
 * replaced - dragging must not reconfigure the engine on every step.
 */
function SettingSlider({
  id,
  label,
  value,
  min,
  max,
  step,
  decimals = 0,
  format,
  onDraft,
  onCommit,
  leftIcon,
  rightIcon
}: {
  id?: string
  label: string
  value: number
  min: number
  max: number
  step: number
  decimals?: number
  format: (value: number) => string
  onDraft: (value: number) => void
  onCommit: (value: number) => void
  leftIcon?: React.ReactNode
  rightIcon?: React.ReactNode
}): React.JSX.Element {
  return (
    <div id={id} onBlur={() => onCommit(value)}>
      <ElasticSlider
        aria-label={label}
        className="w-56 pt-4"
        value={value}
        onValueChange={(next: number) => onDraft(Number(next.toFixed(decimals)))}
        startingValue={min}
        maxValue={max}
        isStepped
        stepSize={step}
        formatValue={format}
        leftIcon={leftIcon ?? <Minus className="size-3.5 text-muted-foreground" />}
        rightIcon={rightIcon ?? <Plus className="size-3.5 text-muted-foreground" />}
      />
    </div>
  )
}

/**
 * Rolling digits with a calm stepper either side (the preview's Values chapter); the counter
 * follows the system's reduced-motion setting itself. Each press drafts
 * at once and saves after a short pause, so stepping 4 → 8 reconfigures the engine once, not four
 * times. A pending save still lands if the panel closes first.
 */
function SettingStepper({
  label,
  value,
  min,
  max,
  step,
  disabled = false,
  format = (next) => String(next),
  onDraft,
  onCommit
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  disabled?: boolean
  format?: (value: number) => string
  onDraft: (value: number) => void
  onCommit: (value: number) => void
}): React.JSX.Element {
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; value: number } | null>(null)
  const commitRef = useRef(onCommit)
  useEffect(() => {
    commitRef.current = onCommit
  })
  useEffect(
    () => () => {
      if (!pending.current) return
      clearTimeout(pending.current.timer)
      commitRef.current(pending.current.value)
    },
    []
  )
  const change = (next: number): void => {
    const clamped = Math.min(max, Math.max(min, next))
    if (clamped === value) return
    onDraft(clamped)
    if (pending.current) clearTimeout(pending.current.timer)
    pending.current = {
      value: clamped,
      timer: setTimeout(() => {
        pending.current = null
        commitRef.current(clamped)
      }, 600)
    }
  }
  return (
    <div
      data-disabled={disabled || undefined}
      className="flex items-center gap-4 transition-opacity duration-300 data-disabled:opacity-40"
    >
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Decrease ${label}`}
        disabled={disabled || value <= min}
        onClick={() => change(value - step)}
      >
        <Minus />
      </Button>
      <span
        role="spinbutton"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuetext={format(value)}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(event) => {
          if (disabled) return
          if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
            event.preventDefault()
            change(value + step)
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
            event.preventDefault()
            change(value - step)
          }
        }}
        className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <Counter
          value={value}
          fontSize={22}
          gap={1}
          horizontalPadding={2}
          fontWeight={300}
          gradientFrom="transparent"
          textColor="var(--foreground)"
        />
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Increase ${label}`}
        disabled={disabled || value >= max}
        onClick={() => change(value + step)}
      >
        <Plus />
      </Button>
    </div>
  )
}

export function SettingsPanel({
  onClose,
  embedded = false,
  initialTab = 'model'
}: {
  onClose: () => void
  embedded?: boolean
  initialTab?: Tab
}): React.JSX.Element {
  const TaskSettings = getSlot(SLOTS.taskSettings)
  const [replySound, setReplySound] = useReplySound()
  const [tab, setTab] = useState<Tab>(initialTab)
  const [s, setS] = useState<LlmSettings>({})
  const [transcriptionInfo, setTranscriptionInfo] = useState<TranscriptionInfo | null>(null)
  const [tools, setTools] = useState<ToolSetting[]>([])
  const [toolsEnabled, setToolsEnabled] = useState(true)
  const [connectorsEnabled, setConnectorsEnabled] = useState(true)
  const [knowledgeRetrieval, setKnowledgeRetrieval] = useState<
    'when-needed' | 'relevant' | 'every-answer'
  >(
    'when-needed'
  )
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<string>>(new Set())
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [newConn, setNewConn] = useState({ name: '', url: '' })
  const [activeModelName, setActiveModelName] = useState<string | null>(null)
  const [draftModels, setDraftModels] = useState<DraftModelOption[]>([])
  const [dflashModels, setDflashModels] = useState<DraftModelOption[]>([])
  // Default hidden, like mobile: the numbers are for when you go looking, not a permanent fixture.
  const [showGenerationDetails, setShowGenerationDetails] = useState(false)
  // The count a stepper returns to when "Choose automatically" is turned off again.
  const [manualThreads, setManualThreads] = useState(8)
  const [manualDraftMax, setManualDraftMax] = useState(4)
  // Remounts the tab content after "Use fastest settings" so every section re-reads its values.
  const [settingsVersion, setSettingsVersion] = useState(0)
  const reloadAfterBestSettings = (): void => {
    ;(window.api as Partial<typeof window.api>)
      .getLlmSettings?.()
      .then((v: LlmSettings) => setS(v))
      .catch(() => {})
    setSettingsVersion((version) => version + 1)
  }
  useEffect(() => {
    const syncToolsEnabled = (event: Event): void => {
      setToolsEnabled((event as CustomEvent<boolean>).detail)
    }
    window.addEventListener('offgrid-tools-enabled-changed', syncToolsEnabled)
    return () => window.removeEventListener('offgrid-tools-enabled-changed', syncToolsEnabled)
  }, [])

  const refreshConnectors = useCallback((): void => {
    ;(window.api as Partial<typeof window.api>)
      .mcpList?.()
      .then((c: Connector[]) => setConnectors(c))
      .catch(() => setConnectors([]))
  }, [])

  useEffect(() => {
    ;(window.api as Partial<typeof window.api>)
      .getLlmSettings?.()
      .then((v: LlmSettings) => setS(v))
      .catch(() => {})
    const modelApi = window.api as Partial<
      Pick<
        typeof window.api,
        'getModelCatalog' | 'getActiveModel' | 'getActiveModelIds' | 'getModelVisionStatus'
      >
    >
    if (
      modelApi.getModelCatalog &&
      modelApi.getActiveModel &&
      modelApi.getActiveModelIds &&
      modelApi.getModelVisionStatus
    ) {
      Promise.all([
        modelApi.getModelCatalog(),
        modelApi.getActiveModel(),
        modelApi.getActiveModelIds(),
        modelApi.getModelVisionStatus(),
        (window.api as Partial<typeof window.api>).getLlmSettings?.()
      ])
        .then(([catalog, activeId, activeIds, companionStatus, llmSettings]) => {
          setActiveModelName(
            resolveActiveTextModel(catalog.models, activeId, new Set(activeIds)).name
          )
          const compatible = installedDraftModels(
            catalog.models,
            activeId,
            companionStatus,
            llmSettings?.compatibleDraftModels ?? [],
            llmSettings?.compatibleDflashModels ?? []
          )
          setDraftModels(compatible.draft)
          setDflashModels(compatible.dflash)
        })
        .catch(() => {
          setActiveModelName(null)
          setDraftModels([])
          setDflashModels([])
        })
    }
    ;(window.api as Partial<typeof window.api>)
      .getTranscriptionInfo?.()
      .then((info: TranscriptionInfo) => setTranscriptionInfo(info))
      .catch(() => setTranscriptionInfo(null))
    ;(window.api as Partial<typeof window.api>)
      .getSettings?.()
      .then((settings) => {
        setShowGenerationDetails(settings.showGenerationDetails === true)
        setToolsEnabled(settings.toolsEnabled !== false)
        setConnectorsEnabled(settings.connectorsEnabled !== false)
        setKnowledgeRetrieval(
          settings.knowledgeBaseRetrieval === 'relevant' ||
            settings.knowledgeBaseRetrieval === 'every-answer'
            ? settings.knowledgeBaseRetrieval
            : 'when-needed'
        )
      })
      .catch(() => {})
    ;(window.api as Partial<typeof window.api>)
      .listTools?.()
      .then((t: ToolSetting[]) => setTools(t))
      .catch(() => {})
    refreshConnectors()
  }, [refreshConnectors])

  // Persist one inference setting (optimistic) — backend applies it per-request.
  const set = (patch: LlmSettings): void => {
    setS((prev) => ({ ...prev, ...patch }))
    void Promise.resolve((window.api as Partial<typeof window.api>).setLlmSettings?.(patch))
      .then(() => (window.api as Partial<typeof window.api>).getLlmSettings?.())
      .then((next) => {
        if (next) {
          setS(next)
          invalidateLlmSettings()
        }
      })
      .catch(() => {
        void (window.api as Partial<typeof window.api>)
          .getLlmSettings?.()
          .then((next) => setS(next))
          .catch(() => {})
      })
  }

  const resetDefaults = (): void => {
    setS((prev) => ({ ...prev, ...DEFAULTS }))
    void Promise.resolve((window.api as Partial<typeof window.api>).setLlmSettings?.(DEFAULTS))
      .then(() => {
        invalidateLlmSettings()
        return (window.api as Partial<typeof window.api>).getLlmSettings?.()
      })
      .then((next) => {
        if (next) setS(next)
      })
      .catch(() => {})
  }

  /**
   * A DISPLAY preference, so it rides saveSetting rather than LlmSettings - nothing here reaches
   * the engine, and putting a UI toggle in the engine's parameter block would send a pointless
   * reconfigure on every flip.
   */
  const toggleGenerationDetails = (): void => {
    const next = !showGenerationDetails
    setShowGenerationDetails(next)
    void Promise.resolve(window.api.saveSetting('showGenerationDetails', next))
      .then(() => invalidateDisplaySettings())
      .catch(() => {
        // The switch is only a mirror of what was stored, so a failed write puts it back.
        setShowGenerationDetails(!next)
      })
  }

  const pickTranscriptionLanguage = (language: string): void => {
    if (!transcriptionInfo) return
    setTranscriptionInfo({ ...transcriptionInfo, language })
    void Promise.resolve(window.api.saveSetting('sttLanguage', language)).catch(() => {
      void (window.api as Partial<typeof window.api>)
        .getTranscriptionInfo?.()
        .then((persisted) => setTranscriptionInfo(persisted))
        .catch(() => {})
    })
  }

  const pickTranscriptionModel = (value: string): void => {
    const modelId = value === DEFAULT_TRANSCRIPTION_MODEL ? null : value
    void Promise.resolve(window.api.setActiveModalModel('transcription', modelId))
      .then(() => (window.api as Partial<typeof window.api>).getTranscriptionInfo?.())
      .then((info) => {
        if (info) setTranscriptionInfo(info)
      })
      .catch(() => {
        void (window.api as Partial<typeof window.api>)
          .getTranscriptionInfo?.()
          .then((persisted) => setTranscriptionInfo(persisted))
          .catch(() => {})
      })
  }

  const addConnector = async (): Promise<void> => {
    if (!newConn.name.trim() || !newConn.url.trim()) return
    await (window.api as Partial<typeof window.api>).mcpAdd?.({
      name: newConn.name.trim(),
      transport: 'http',
      url: newConn.url.trim()
    })
    setNewConn({ name: '', url: '' })
    refreshConnectors()
  }

  const openActiveModels = (): void => {
    onClose()
    openActiveModelsPanel()
  }

  const connectorGroups = groupConnectors(connectors)
  // One connector: its name and URL, an On/Off switch that stays visible, Remove on hover.
  const connectorRow = (c: Connector): React.JSX.Element => (
    <motion.div
      key={c.id}
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
    >
      <ListRow
        density="compact"
        title={c.name}
        description={c.url ?? undefined}
        // On/Off is state, so it stays visible; only Remove waits for hover.
        meta={
          <label className="flex cursor-pointer items-center gap-2">
            <span
              className={`text-[11px] transition-colors duration-300 ${c.enabled ? 'text-green-500' : 'text-neutral-500'}`}
            >
              <TextMorph as="span">{c.enabled ? 'On' : 'Off'}</TextMorph>
            </span>
            <Switch
              aria-label={`Enable ${c.name}`}
              checked={Boolean(c.enabled)}
              onCheckedChange={async () => {
                await (window.api as Partial<typeof window.api>).mcpSetEnabled?.(c.id, !c.enabled)
                refreshConnectors()
              }}
            />
          </label>
        }
        actions={
          <IconTip label="Remove">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Remove"
              className="text-neutral-500 hover:text-red-400"
              onClick={async () => {
                await (window.api as Partial<typeof window.api>).mcpRemove?.(c.id)
                refreshConnectors()
              }}
            >
              <Trash />
            </Button>
          </IconTip>
        }
      />
    </motion.div>
  )

  const content = (
    <>
      {!embedded ? (
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm text-neutral-200">
            <span className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-green-500">
              Settings
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={openActiveModels}>
              Active models
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close">
              <X />
            </Button>
          </div>
        </div>
      ) : null}

      <BestSettingsCard onApplied={reloadAfterBestSettings} />

      <div className="flex flex-nowrap items-center gap-1 overflow-x-auto border-b border-neutral-800 px-3 py-2">
        <Segmented
          label="Settings sections"
          size="sm"
          tone="quiet"
          value={tab}
          onValueChange={setTab}
          options={(
            [
              'model',
              'image',
              'voice',
              'transcription',
              'remote',
              ...(TaskSettings ? (['tasks'] as const) : []),
              'tools',
              'connectors'
            ] as const
          ).map((t) => ({
            id: t,
            label: t === 'model' ? 'Text' : t,
            icon: <span className="capitalize">{t === 'model' ? 'Text' : t}</span>
          }))}
        />
      </div>

      <div
        key={settingsVersion}
        className={embedded ? 'p-1 pt-4 text-sm' : 'min-h-0 flex-1 overflow-y-auto p-4 text-sm'}
      >
        {tab === 'tasks' && TaskSettings ? (
          <>
            {/* The registry returns a stable registered component, not a component factory. */}
            {/* eslint-disable-next-line react-hooks/static-components */}
            <TaskSettings />
            {/* The task models' own backends live with the task settings that choose them. */}
            <SettingsSection
              id="tasks.backends"
              title="Task model backends"
              summary="Which processor runs the grounding specialist and the decision model."
            >
              <BackendPreferencesSection modalities={['grounding', 'decision']} />
            </SettingsSection>
          </>
        ) : null}
        {tab === 'model' && (
          <>
            <SettingsSection
              id="text.model"
              title="Model and memory"
              summary={`${activeModelName ?? 'No active model'} · context ${formatContextWindow(s.ctxSize) ?? 'checking'}`}
              defaultOpen
            >
              <div className="mb-3" role="status">
                <AnimatedGroup
                  preset="fade"
                  className="grid grid-cols-2 gap-px border border-neutral-800 bg-neutral-800 lg:grid-cols-4"
                >
                  {[
                    ['Current model', activeModelName ?? 'No active model'],
                    ['Configured', formatContextWindow(s.ctxSize) ?? 'Checking'],
                    ['Running', formatContextWindow(s.effectiveCtxSize) ?? 'Checking'],
                    [
                      'Recommended',
                      formatContextWindow(recommendedContextWindow(s.modelMaxCtx)) ??
                        'Not supported'
                    ]
                  ].map(([label, value]) => (
                    <Stat
                      key={label}
                      className="h-full rounded-none border-0 bg-neutral-950/90 p-3 shadow-none"
                    >
                      <StatLabel className="text-[10px] font-normal uppercase tracking-wide text-neutral-600">
                        {label}
                      </StatLabel>
                      <StatValue
                        className="min-w-0 truncate text-xs font-normal tracking-normal text-neutral-200"
                        title={value}
                      >
                        {value}
                      </StatValue>
                    </Stat>
                  ))}
                </AnimatedGroup>
              </div>
              {/* Order matters: the OUTER budget first, because each inner one is bounded by it.
                thinking budget within max output within context window (rule in @offgrid/models). */}
              <BackendPreferencesSection modalities={['llm']} />
              <Row
                inline
                label="Context window"
                controlId="context-window"
                hint={`${contextWindowHint(s)} 16K is recommended for capture and chat.`}
              >
                <SettingsSelect
                  id="context-window"
                  label="Context window"
                  value={String(s.ctxSize ?? DEFAULT_CTX_SIZE)}
                  onValueChange={(value) => set(budgetChange(s, { ctxSize: Number(value) }))}
                  options={contextWindowOptions(
                    CTX_OPTIONS,
                    s.modelMaxCtx,
                    s.ctxSize ?? DEFAULT_CTX_SIZE
                  ).map((value) => ({
                    value: String(value),
                    label: `${value >= 1024 ? `${value / 1024}K` : value} tokens${
                      value === s.modelMaxCtx
                        ? " (model's max)"
                        : value === DEFAULT_CTX_SIZE
                          ? ' (recommended)'
                          : value < MIN_CAPTURE_CTX_SIZE
                            ? ' (capture unavailable)'
                            : ''
                    }`
                  }))}
                />
              </Row>
              <Row
                inline
                label="Max output"
                controlId="max-output"
                hint={
                  (s.maxTokens ?? MAX_OUTPUT_AUTO) === MAX_OUTPUT_AUTO
                    ? 'Auto: the reply runs until the model stops or the context window fills - no fixed cap.'
                    : 'Hard cap on the response length. Cannot exceed the context window.'
                }
              >
                <SettingsSelect
                  id="max-output"
                  label="Max output"
                  value={String(s.maxTokens ?? MAX_OUTPUT_AUTO)}
                  onValueChange={(value) => set(budgetChange(s, { maxTokens: Number(value) }))}
                  options={[
                    { value: String(MAX_OUTPUT_AUTO), label: 'Auto (until the model stops)' },
                    ...optionsWithinCeiling(MAX_OUTPUT_OPTIONS, s.ctxSize ?? DEFAULT_CTX_SIZE).map(
                      (value) => ({ value: String(value), label: `${value / 1024}K tokens` })
                    )
                  ]}
                />
              </Row>
              <Row
                inline
                label="Thinking budget"
                controlId="thinking-budget"
                hint={
                  (s.reasoningBudget ?? REASONING_BUDGET_AUTO) === REASONING_BUDGET_AUTO
                    ? 'Auto: when Thinking is on, the model reasons for as long as it wants - it can spend the whole response reasoning and never answer.'
                    : 'Cap on the tokens spent thinking. At the cap the model stops reasoning and answers. Cannot exceed Max output.'
                }
              >
                <SettingsSelect
                  id="thinking-budget"
                  label="Thinking budget"
                  value={String(s.reasoningBudget ?? REASONING_BUDGET_AUTO)}
                  onValueChange={(value) =>
                    set(budgetChange(s, { reasoningBudget: Number(value) }))
                  }
                  options={thinkingBudgetOptions(s).map((value) => ({
                    value: String(value),
                    label: reasoningBudgetLabel(value)
                  }))}
                />
              </Row>
            </SettingsSection>
            <SettingsSection
              id="text.answers"
              title="Answers"
              summary={`Temperature ${(s.temperature ?? 0.7).toFixed(2)} · up to ${s.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS} tool calls`}
              defaultOpen
            >
              <Row inline label="Temperature" hint="Lower = focused, higher = creative.">
                <SettingSlider
                  label="Temperature"
                  value={s.temperature ?? 0.7}
                  min={0}
                  max={1.5}
                  step={0.05}
                  decimals={2}
                  format={(value) => value.toFixed(2)}
                  onDraft={(value) => setS((current) => ({ ...current, temperature: value }))}
                  onCommit={(value) => set({ temperature: value })}
                  leftIcon={<Snowflake className="size-4 text-muted-foreground" />}
                  rightIcon={<Flame className="size-4 text-muted-foreground" />}
                />
              </Row>
              <Row
                inline
                label="Generation details"
                controlId="generation-details-toggle"
                hint="Show context use, speed, token count, time, and the tools sent with the request under each answer."
              >
                <Switch
                  id="generation-details-toggle"
                  aria-label="Generation details"
                  checked={showGenerationDetails}
                  onCheckedChange={toggleGenerationDetails}
                />
              </Row>
              <Row
                inline
                label="Reply sound"
                controlId="reply-sound-toggle"
                hint="A soft ding when an answer arrives, here and in God. The same setting in both."
              >
                <Switch
                  id="reply-sound-toggle"
                  aria-label="Reply sound"
                  checked={replySound}
                  onCheckedChange={() => setReplySound(!replySound)}
                />
              </Row>
              <Row
                inline
                label="Project knowledge"
                hint="When needed searches a project's knowledge base only for questions that need it, so other answers stay fast. Relevant passages searches it for every question and adds the best matches. Every answer reads all of it each time."
              >
                <Segmented
                  label="Project knowledge"
                  size="sm"
                  value={knowledgeRetrieval}
                  onValueChange={(value) => {
                    setKnowledgeRetrieval(value)
                    void window.api.saveSetting('knowledgeBaseRetrieval', value)
                  }}
                  options={[
                    { id: 'when-needed', label: 'When needed' },
                    { id: 'relevant', label: 'Relevant passages' },
                    { id: 'every-answer', label: 'Every answer' }
                  ]}
                />
              </Row>
              <Row
                inline
                label="Maximum tool calls"
                controlId="maximum-tool-calls"
                hint="Emergency limit for tool calls in one response."
              >
                <SettingSlider
                  id="maximum-tool-calls"
                  label="Maximum tool calls"
                  value={s.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS}
                  min={MIN_MAX_TOOL_CALLS}
                  max={MAX_MAX_TOOL_CALLS}
                  step={1}
                  format={(value) => String(value)}
                  onDraft={(value) =>
                    setS((current) => ({ ...current, maxToolCalls: Math.round(value) }))
                  }
                  onCommit={(value) => set({ maxToolCalls: Math.round(value) })}
                />
              </Row>
              <Row
                label="System prompt"
                hint="Prepended to every chat as a system message. Leave blank for the default."
              >
                <Textarea
                  value={s.systemPrompt ?? ''}
                  onChange={(e) =>
                    setS((current) => ({ ...current, systemPrompt: e.target.value }))
                  }
                  onBlur={(e) => set({ systemPrompt: e.target.value })}
                  rows={5}
                  placeholder="e.g. You are a concise, technical assistant."
                  className="resize-none"
                />
              </Row>
            </SettingsSection>
            <SettingsSection
              id="text.sampling"
              title="Sampling"
              summary={`Top-P ${(s.topP ?? 0.95).toFixed(2)} · Top-K ${s.topK ?? 40} · repeat penalty ${(s.repeatPenalty ?? 1.1).toFixed(2)}`}
            >
              <Row inline label="Top-P" hint="Nucleus sampling cutoff.">
                <SettingSlider
                  label="Top-P"
                  value={s.topP ?? 0.95}
                  min={0}
                  max={1}
                  step={0.01}
                  decimals={2}
                  format={(value) => value.toFixed(2)}
                  onDraft={(value) => setS((current) => ({ ...current, topP: value }))}
                  onCommit={(value) => set({ topP: value })}
                />
              </Row>
              <Row inline label="Top-K" hint="0 disables. Limits candidate tokens.">
                <SettingSlider
                  label="Top-K"
                  value={s.topK ?? 40}
                  min={0}
                  max={100}
                  step={1}
                  format={(value) => String(value)}
                  onDraft={(value) => setS((current) => ({ ...current, topK: value }))}
                  onCommit={(value) => set({ topK: value })}
                />
              </Row>
              <Row inline label="Min-P" hint="Min probability relative to the top token.">
                <SettingSlider
                  label="Min-P"
                  value={s.minP ?? 0.05}
                  min={0}
                  max={0.5}
                  step={0.01}
                  decimals={2}
                  format={(value) => value.toFixed(2)}
                  onDraft={(value) => setS((current) => ({ ...current, minP: value }))}
                  onCommit={(value) => set({ minP: value })}
                />
              </Row>
              <Row inline label="Repeat penalty" hint="Higher discourages repetition.">
                <SettingSlider
                  label="Repeat penalty"
                  value={s.repeatPenalty ?? 1.1}
                  min={1}
                  max={1.5}
                  step={0.01}
                  decimals={2}
                  format={(value) => value.toFixed(2)}
                  onDraft={(value) => setS((current) => ({ ...current, repeatPenalty: value }))}
                  onCommit={(value) => set({ repeatPenalty: value })}
                />
              </Row>
            </SettingsSection>
            <SettingsSection
              id="text.performance"
              title="Performance"
              summary={
                'KV cache, FlashAttention, GPU layers and threads. Changing any reloads the model.'
              }
            >
              <Row
                inline
                label="KV cache"
                hint="Quantize the KV cache to cut memory and allow a larger context. q8_0 ≈ half, q4_0 ≈ quarter of f16. Auto-enables FlashAttention."
              >
                <Segmented
                  label="KV cache"
                  size="sm"
                  value={s.kvCacheType ?? 'f16'}
                  onValueChange={(t) =>
                    set({ kvCacheType: t, ...(t !== 'f16' ? { flashAttn: true } : {}) })
                  }
                  options={(['f16', 'q8_0', 'q4_0'] as const).map((t) => ({ id: t, label: t }))}
                />
              </Row>
              <Row
                inline
                label="FlashAttention"
                controlId="flash-attention-toggle"
                hint="Faster, lower memory. Required for a quantized KV cache."
              >
                <Switch
                  id="flash-attention-toggle"
                  aria-label="FlashAttention"
                  checked={s.flashAttn ?? false}
                  disabled={(s.kvCacheType ?? 'f16') !== 'f16'}
                  onCheckedChange={() => set({ flashAttn: !(s.flashAttn ?? false) })}
                />
              </Row>
              <Row
                inline
                label="Speculative decoding"
                controlId="speculative-decoding"
                hint="N-gram needs no second model. MTP uses prediction heads in the main model or its matching installed MTP file. Draft and DFlash need a compatible installed draft GGUF."
              >
                <SettingsSelect
                  id="speculative-decoding"
                  label="Speculative decoding"
                  value={s.speculativeDecoding ?? 'off'}
                  onValueChange={(value) =>
                    set(speculativePatch(s, { speculativeDecoding: value as SpeculativeMode }))
                  }
                  options={speculativeOptions(s)}
                />
              </Row>
              {['mtp', 'draft', 'dflash'].includes(s.speculativeDecoding ?? 'off') && (
                <Row
                  inline
                  label="Draft token limit"
                  controlId="speculative-draft-max"
                  hint="Maximum tokens proposed per step. More is not always faster. Auto uses two for MTP and the engine default for Draft and DFlash."
                >
                  <div id="speculative-draft-max" className="flex items-center gap-3">
                    <SettingStepper
                      label="Draft token limit"
                      value={
                        (s.speculativeDraftMax ?? 0) > 0 ? s.speculativeDraftMax! : manualDraftMax
                      }
                      min={1}
                      max={16}
                      step={1}
                      disabled={(s.speculativeDraftMax ?? 0) === 0}
                      format={(value) => `${value} tokens`}
                      onDraft={(value) => {
                        setManualDraftMax(value)
                        setS((current) => ({ ...current, speculativeDraftMax: value }))
                      }}
                      onCommit={(value) => set({ speculativeDraftMax: value })}
                    />
                    <label className="flex w-fit cursor-pointer items-center gap-3 text-[12px] text-muted-foreground">
                      <Switch
                        aria-label="Choose the draft token limit automatically"
                        checked={(s.speculativeDraftMax ?? 0) === 0}
                        onCheckedChange={(auto) =>
                          set({ speculativeDraftMax: auto ? 0 : manualDraftMax })
                        }
                      />
                      Auto
                    </label>
                  </div>
                </Row>
              )}
              {(s.speculativeDecoding === 'draft' || s.speculativeDecoding === 'dflash') && (
                <Row
                  label="Draft model"
                  controlId="speculative-draft-model"
                  hint="Use a smaller GGUF that is tokenizer-compatible with the active model."
                >
                  <SettingsSelect
                    id="speculative-draft-model"
                    label="Draft model"
                    value={s.draftModel ?? ''}
                    options={s.speculativeDecoding === 'dflash' ? dflashModels : draftModels}
                    placeholder="No compatible model installed"
                    searchable
                    disabled={
                      s.speculativeDecoding === 'dflash'
                        ? dflashModels.length === 0
                        : draftModels.length === 0
                    }
                    onValueChange={(value) => set({ draftModel: value })}
                  />
                </Row>
              )}
              <Row inline label="GPU layers" hint={gpuLayersHint(s.gpuAccelerator ?? null)}>
                <SettingSlider
                  label="GPU layers"
                  value={s.gpuLayers ?? 99}
                  min={0}
                  max={99}
                  step={1}
                  format={(value) => String(value)}
                  onDraft={(value) => setS((current) => ({ ...current, gpuLayers: value }))}
                  onCommit={(value) => set({ gpuLayers: value })}
                />
              </Row>
              <Row inline label="CPU threads" hint="Auto lets llama.cpp choose.">
                <div className="flex items-center gap-3">
                  <SettingStepper
                    label="CPU threads"
                    value={(s.threads ?? 0) > 0 ? s.threads! : manualThreads}
                    min={1}
                    max={16}
                    step={1}
                    disabled={(s.threads ?? 0) === 0}
                    onDraft={(value) => {
                      setManualThreads(value)
                      setS((current) => ({ ...current, threads: value }))
                    }}
                    onCommit={(value) => set({ threads: value })}
                  />
                  <label className="flex w-fit cursor-pointer items-center gap-3 text-[12px] text-muted-foreground">
                    <Switch
                      aria-label="Choose CPU threads automatically"
                      checked={(s.threads ?? 0) === 0}
                      onCheckedChange={(auto) => set({ threads: auto ? 0 : manualThreads })}
                    />
                    Auto
                  </label>
                </div>
              </Row>
              <Row inline label="Batch size" hint="Tokens processed per batch during prompt ingest.">
                <SettingSlider
                  label="Batch size"
                  value={s.batchSize ?? 512}
                  min={64}
                  max={2048}
                  step={64}
                  format={(value) => String(value)}
                  onDraft={(value) => setS((current) => ({ ...current, batchSize: value }))}
                  onCommit={(value) => set({ batchSize: value })}
                />
              </Row>
            </SettingsSection>

            <div className="mt-2 flex justify-end">
              <IconTip label="Reset to defaults">
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label="Reset to defaults"
                  onClick={resetDefaults}
                >
                  <ArrowCounterClockwise />
                </Button>
              </IconTip>
            </div>
          </>
        )}

        {tab === 'image' && <ImageSettingsTab />}

        {tab === 'remote' && <RemoteVisionSettingsTab />}

        {tab === 'voice' && <VoiceSettingsTab />}

        {tab === 'transcription' && (
          <>
            <SettingsSection
              id="transcription.model"
              title="Model and language"
              summary={`${transcriptionInfo?.options.find((option) => option.active)?.name ?? 'Checking'} · ${transcriptionInfo?.languages.find((l) => l.code === transcriptionInfo.language)?.label ?? 'Auto-detect'}`}
              defaultOpen
            >
              <Row
                inline
                label="Current model"
                controlId="transcription-model"
                hint={transcriptionInfo?.label ?? 'The model used for the next recording.'}
              >
                <SettingsSelect
                  id="transcription-model"
                  label="Current transcription model"
                  value={
                    transcriptionInfo?.options.find((option) => option.active)?.id ??
                    DEFAULT_TRANSCRIPTION_MODEL
                  }
                  placeholder="Checking installed models..."
                  onValueChange={pickTranscriptionModel}
                  disabled={!transcriptionInfo || transcriptionInfo.options.length === 0}
                  options={(transcriptionInfo?.options ?? []).map((option) => ({
                    value: option.id ?? DEFAULT_TRANSCRIPTION_MODEL,
                    label: option.name
                  }))}
                />
              </Row>
              <Row
                inline
                label="Spoken language"
                controlId="stt-language"
                hint="Auto-detect is available for multilingual Whisper models. English-only models show English only."
              >
                <SettingsSelect
                  id="stt-language"
                  label="Spoken language"
                  value={transcriptionInfo?.language ?? 'auto'}
                  onValueChange={pickTranscriptionLanguage}
                  disabled={!transcriptionInfo}
                  options={(transcriptionInfo?.languages ?? []).map((language) => ({
                    value: language.code,
                    label: language.label
                  }))}
                />
              </Row>
              {/* One row needs no section of its own: the processor sits with the model it runs. */}
              <BackendPreferencesSection modalities={['stt']} />
            </SettingsSection>
          </>
        )}

        {tab === 'tools' && (
          <>
            <SettingRow
              icon={<Wrench />}
              title="Enable tools"
              description="Controls whether any tools are sent to the chat model."
              className="mb-3 pt-0"
            >
              <Switch
                aria-label="Enable tools"
                checked={toolsEnabled}
                onCheckedChange={() => {
                  const next = !toolsEnabled
                  setToolsEnabled(next)
                  void window.api.saveSetting('toolsEnabled', next)
                  window.dispatchEvent(
                    new CustomEvent('offgrid-tools-enabled-changed', { detail: next })
                  )
                }}
              />
            </SettingRow>
            {tools.length === 0 ? (
              <p className="text-xs text-neutral-600">No tools.</p>
            ) : (
              <div className="flex flex-col divide-y divide-neutral-800 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900/40">
                {groupTools(tools).map((group) => {
                  const enabledCount = group.tools.filter((tool) => tool.enabled !== false).length
                  const allEnabled = enabledCount === group.tools.length
                  const groupState = enabledCount === 0 ? 'Off' : allEnabled ? 'On' : 'Mixed'
                  const groupId = group.label.toLowerCase().replaceAll(' ', '-')
                  const isExpanded = expandedToolGroups.has(group.label)

                  return (
                    <section
                      key={group.label}
                      aria-labelledby={`tool-group-${groupId}`}
                      className="overflow-hidden"
                    >
                      <div
                        className={`flex items-center justify-between gap-3 px-3 py-2 ${isExpanded ? 'border-b border-neutral-800' : ''}`}
                      >
                        <button
                          type="button"
                          aria-expanded={isExpanded}
                          aria-controls={`tool-group-items-${groupId}`}
                          onClick={() => {
                            setExpandedToolGroups((current) => {
                              const next = new Set(current)
                              if (next.has(group.label)) next.delete(group.label)
                              else next.add(group.label)
                              return next
                            })
                          }}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          <CaretRight
                            size={14}
                            aria-hidden="true"
                            className={`shrink-0 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
                          />
                          <span className="flex min-w-0 items-baseline gap-2">
                            <span
                              id={`tool-group-${groupId}`}
                              role="heading"
                              aria-level={3}
                              className="truncate text-[11px] uppercase tracking-wide text-neutral-400"
                            >
                              {group.label}
                            </span>
                            <span className="shrink-0 text-[10px] text-neutral-600">
                              {enabledCount} of {group.tools.length} on
                            </span>
                          </span>
                        </button>
                        <label className="flex shrink-0 cursor-pointer items-center gap-2">
                          <span
                            className={`text-[11px] transition-colors duration-300 ${allEnabled ? 'text-green-500' : 'text-neutral-500'}`}
                          >
                            <TextMorph as="span">{groupState}</TextMorph>
                          </span>
                          <Switch
                            aria-label={`Enable ${group.label} tools`}
                            checked={allEnabled ? true : enabledCount === 0 ? false : 'mixed'}
                            onCheckedChange={() => {
                              // Mixed turns the whole group on, as the switch reports it.
                              const next = !allEnabled
                              const names = new Set(group.tools.map((tool) => tool.name))
                              const nextTools = tools.map((tool) =>
                                names.has(tool.name) ? { ...tool, enabled: next } : tool
                              )
                              void persistToggle(nextTools, tools, setTools, async () => {
                                try {
                                  for (const tool of group.tools) {
                                    await (
                                      window.api as Partial<typeof window.api>
                                    ).setToolEnabled?.(tool.name, next)
                                  }
                                } catch {
                                  setTools(await window.api.listTools())
                                }
                              })
                            }}
                          />
                        </label>
                      </div>
                      <AutoHeight>
                        {isExpanded && (
                          <div
                            id={`tool-group-items-${groupId}`}
                            className="divide-y divide-neutral-800/70"
                          >
                            {group.tools.map((tool) => (
                              <div
                                key={tool.name}
                                className="flex items-start justify-between gap-3 px-3 py-2 transition-colors duration-150 hover:bg-neutral-800/30"
                              >
                                <div className="min-w-0">
                                  <div
                                    className={`text-sm ${tool.enabled === false ? 'text-neutral-500' : 'text-green-500'}`}
                                  >
                                    {tool.name}
                                  </div>
                                  <div className="text-[11px] text-neutral-500">
                                    {tool.description}
                                  </div>
                                </div>
                                <Switch
                                  aria-label={`Enable ${tool.name}`}
                                  checked={tool.enabled !== false}
                                  onCheckedChange={() => {
                                    const next = tool.enabled === false
                                    void persistToggle(
                                      tools.map((item) =>
                                        item.name === tool.name ? { ...item, enabled: next } : item
                                      ),
                                      tools,
                                      setTools,
                                      () =>
                                        (window.api as Partial<typeof window.api>).setToolEnabled?.(
                                          tool.name,
                                          next
                                        )
                                    )
                                  }}
                                />
                              </div>
                            ))}
                          </div>
                        )}
                      </AutoHeight>
                    </section>
                  )
                })}
              </div>
            )}
            {/* One row needs no section of its own. */}
            <div className="mt-4">
              <BackendPreferencesSection modalities={['embeddings']} />
            </div>
          </>
        )}

        {tab === 'connectors' && (
          <>
            <SettingRow
              icon={<Plugs />}
              title="Enable connectors"
              description="Controls whether any connector tools are sent to the chat model."
              className="mb-3 pt-0"
            >
              <Switch
                aria-label="Enable connectors"
                checked={connectorsEnabled}
                onCheckedChange={() => {
                  const next = !connectorsEnabled
                  setConnectorsEnabled(next)
                  void window.api.saveSetting('connectorsEnabled', next)
                }}
              />
            </SettingRow>
            <p className="mb-2 text-[11.5px] leading-snug text-neutral-500">
              Connect MCP servers — your reusable tool library (web search, fetch, etc.). Add an
              HTTP MCP endpoint:
            </p>
            <div className="mb-4 flex items-center gap-2">
              <Input
                size="sm"
                className="w-32 shrink-0"
                value={newConn.name}
                onChange={(e) => setNewConn({ ...newConn, name: e.target.value })}
                placeholder="Name (e.g. Brave Search)"
              />
              <Input
                size="sm"
                className="min-w-0 flex-1"
                value={newConn.url}
                onChange={(e) => setNewConn({ ...newConn, url: e.target.value })}
                placeholder="https://… (MCP HTTP URL)"
              />
              <IconTip label="Add connector">
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label="Add connector"
                  onClick={addConnector}
                  disabled={!newConn.name.trim() || !newConn.url.trim()}
                >
                  <Plus />
                </Button>
              </IconTip>
            </div>
            {connectors.length === 0 ? (
              <Empty className="px-0 py-6 md:py-6">
                <EmptyMedia variant="icon">
                  <Plugs className="text-neutral-600" />
                </EmptyMedia>
                <EmptyDescription className="text-xs text-neutral-600">
                  No connectors yet.
                </EmptyDescription>
              </Empty>
            ) : (
              // By service: several accounts and servers of one service sit together in a section;
              // a service with one connector is just its row, in one thin list above them.
              <div className="flex flex-col">
                {connectorGroups.some((group) => group.connectors.length === 1) && (
                  <div className="mb-2 flex flex-col divide-y divide-neutral-900 rounded-md border border-neutral-800 bg-neutral-950/40">
                    <AnimatePresence initial={false}>
                      {connectorGroups
                        .filter((group) => group.connectors.length === 1)
                        .flatMap((group) => group.connectors.map((c) => connectorRow(c)))}
                    </AnimatePresence>
                  </div>
                )}
                {connectorGroups
                  .filter((group) => group.connectors.length > 1)
                  .map((group) => (
                    <SettingsSection
                      key={group.key}
                      id={`connectors.${group.key}`}
                      title={group.label}
                      summary={`${group.connectors.length} connected · ${
                        group.connectors.filter((c) => c.enabled).length
                      } on`}
                    >
                      <div className="flex flex-col divide-y divide-neutral-900 pb-2">
                        <AnimatePresence initial={false}>
                          {group.connectors.map((c) => connectorRow(c))}
                        </AnimatePresence>
                      </div>
                    </SettingsSection>
                  ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  )

  if (embedded) {
    return <div className="flex min-h-0 flex-col bg-neutral-950/20 font-mono">{content}</div>
  }

  return (
    <SidePanel
      ariaLabel="Model settings"
      onClose={onClose}
      className="w-[calc(30vw+250px)] min-w-[670px]"
    >
      {content}
    </SidePanel>
  )
}
