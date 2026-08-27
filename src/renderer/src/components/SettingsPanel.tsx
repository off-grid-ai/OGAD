import { useCallback, useEffect, useState } from 'react'
import { persistToggle } from '@renderer/lib/persist-toggle'
import {
  DEFAULT_CTX_SIZE,
  MAX_TOKENS_AUTO,
  MIN_CAPTURE_CTX_SIZE
} from '@offgrid/core/shared/llm-defaults'
import {
  REASONING_BUDGET_AUTO,
  REASONING_BUDGET_OPTIONS,
  reasoningBudgetLabel,
  optionsWithinCeiling,
  reconcileBudgets
} from '@offgrid/models'
import { gpuLayersHint, type EngineAccelerator } from '@offgrid/core/shared/engine-accelerator'
import {
  contextWindowOptions,
  contextWindowHint,
  recommendedContextWindow
} from '@renderer/lib/ctx-options'
import { formatContextWindow, resolveModelName } from '@renderer/lib/model-summary'
import type { ModelSettingsPanelTab as Tab } from '@renderer/lib/model-settings-panel'
import { ImageSettingsTab } from './ImageSettingsTab'
import { SidePanel } from './SidePanel'
import { VoiceSettingsTab } from './VoiceSettingsTab'
import { RemoteVisionSettingsTab } from './RemoteVisionSettingsTab'
import { SettingsRow as Row } from './SettingsRow'
import { SettingsSelect } from './SettingsSelect'
import type { SpeechLanguage } from '@offgrid/speech'

const MAX_OUTPUT_AUTO = MAX_TOKENS_AUTO
// The values THIS picker offers. The nesting rule they obey is shared (@offgrid/models); which
// discrete steps to show is a desktop rendering choice, and OGAM uses sliders instead.
const MAX_OUTPUT_OPTIONS = [2048, 4096, 8192, 16384, 32768]

/** The ceiling on thinking: the response length it must fit inside, which for an auto output cap
 *  is the context window. Mirrors reconcileBudgets so the options offered match what is kept. */
function thinkingCeiling(s: LlmSettings): number {
  const maxOutput = s.maxTokens ?? MAX_OUTPUT_AUTO
  const ctx = s.ctxSize ?? DEFAULT_CTX_SIZE
  return maxOutput === MAX_OUTPUT_AUTO ? ctx : maxOutput
}

/**
 * Apply one budget edit and pull the inner budgets back under it.
 *
 * Filtering the option lists stops a user PICKING an impossible combination; this stops an already
 * stored one surviving a change to an outer limit. Both read the same rule from @offgrid/models,
 * so the picker and the persisted value cannot disagree. Only genuinely changed fields are
 * returned, so an unrelated edit does not rewrite the other two.
 */
function budgetChange(s: LlmSettings, patch: LlmSettings): LlmSettings {
  const next = { ...s, ...patch }
  const reconciled = reconcileBudgets({
    contextWindow: next.ctxSize ?? DEFAULT_CTX_SIZE,
    maxOutput: next.maxTokens ?? MAX_OUTPUT_AUTO,
    thinkingBudget: next.reasoningBudget ?? REASONING_BUDGET_AUTO
  })
  return {
    ...patch,
    ...(reconciled.maxOutput !== (next.maxTokens ?? MAX_OUTPUT_AUTO)
      ? { maxTokens: reconciled.maxOutput }
      : {}),
    ...(reconciled.thinkingBudget !== (next.reasoningBudget ?? REASONING_BUDGET_AUTO)
      ? { reasoningBudget: reconciled.thinkingBudget }
      : {})
  }
}

// Right-side Settings panel (same pattern as SkillsPanel/ArtifactCanvas).
// Tabs: Model (inference params), Image, Voice (Kokoro TTS), Tools (built-in, read-only),
// Connectors (MCP servers — the user's reusable tool library). All on-device.
type KvCacheType = 'f16' | 'q8_0' | 'q4_0'
type LlmSettings = {
  temperature?: number
  ctxSize?: number
  topP?: number
  topK?: number
  minP?: number
  repeatPenalty?: number
  maxTokens?: number
  reasoningBudget?: number
  systemPrompt?: string
  kvCacheType?: KvCacheType
  flashAttn?: boolean
  gpuLayers?: number
  threads?: number
  batchSize?: number
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

type TranscriptionInfo = {
  engine: 'whisper' | 'parakeet' | 'whisper-resident'
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
  ctxSize: DEFAULT_CTX_SIZE,
  systemPrompt: '',
  kvCacheType: 'f16',
  flashAttn: false,
  gpuLayers: 99,
  threads: 0,
  batchSize: 512
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
  const [tab, setTab] = useState<Tab>(initialTab)
  const [s, setS] = useState<LlmSettings>({})
  const [transcriptionInfo, setTranscriptionInfo] = useState<TranscriptionInfo | null>(null)
  const [tools, setTools] = useState<{ name: string; description: string; enabled?: boolean }[]>([])
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [newConn, setNewConn] = useState({ name: '', url: '' })
  const [activeModelName, setActiveModelName] = useState<string | null>(null)

  const refreshConnectors = useCallback((): void => {
    window.api
      .mcpList?.()
      .then((c: Connector[]) => setConnectors(c))
      .catch(() => setConnectors([]))
  }, [])

  useEffect(() => {
    window.api
      .getLlmSettings?.()
      .then((v: LlmSettings) => setS(v))
      .catch(() => {})
    const modelApi = window.api as Partial<
      Pick<typeof window.api, 'getModelCatalog' | 'getActiveModel'>
    >
    if (modelApi.getModelCatalog && modelApi.getActiveModel) {
      Promise.all([modelApi.getModelCatalog(), modelApi.getActiveModel()])
        .then(([catalog, activeId]) =>
          setActiveModelName(resolveModelName(catalog.models, activeId))
        )
        .catch(() => setActiveModelName(null))
    }
    window.api
      .getTranscriptionInfo?.()
      .then((info: TranscriptionInfo) => setTranscriptionInfo(info))
      .catch(() => setTranscriptionInfo(null))
    window.api
      .listTools?.()
      .then((t: { name: string; description: string }[]) => setTools(t))
      .catch(() => {})
    refreshConnectors()
  }, [refreshConnectors])

  // Persist one inference setting (optimistic) — backend applies it per-request.
  const set = (patch: LlmSettings): void => {
    setS((prev) => ({ ...prev, ...patch }))
    void Promise.resolve(window.api.setLlmSettings?.(patch))
      .then(() => window.api.getLlmSettings?.())
      .then((next) => {
        if (next) setS(next)
      })
      .catch(() => {
        void window.api
          .getLlmSettings?.()
          .then((next) => setS(next))
          .catch(() => {})
      })
  }

  const resetDefaults = (): void => {
    setS((prev) => ({ ...prev, ...DEFAULTS }))
    window.api.setLlmSettings?.(DEFAULTS)
  }

  const pickTranscriptionLanguage = (language: string): void => {
    if (!transcriptionInfo) return
    setTranscriptionInfo({ ...transcriptionInfo, language })
    void Promise.resolve(window.api.saveSetting('sttLanguage', language)).catch(() => {
      void window.api
        .getTranscriptionInfo()
        .then((persisted) => setTranscriptionInfo(persisted))
        .catch(() => {})
    })
  }

  const pickTranscriptionModel = (value: string): void => {
    const modelId = value === DEFAULT_TRANSCRIPTION_MODEL ? null : value
    void Promise.resolve(window.api.setActiveModalModel('transcription', modelId))
      .then(() => window.api.getTranscriptionInfo())
      .then((info) => setTranscriptionInfo(info))
      .catch(() => {
        void window.api
          .getTranscriptionInfo()
          .then((persisted) => setTranscriptionInfo(persisted))
          .catch(() => {})
      })
  }

  const addConnector = async (): Promise<void> => {
    if (!newConn.name.trim() || !newConn.url.trim()) return
    await window.api.mcpAdd?.({
      name: newConn.name.trim(),
      transport: 'http',
      url: newConn.url.trim()
    })
    setNewConn({ name: '', url: '' })
    refreshConnectors()
  }

  const content = (
    <>
      {!embedded ? (
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm text-neutral-200">
            <span className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-green-500">
              Settings
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-300 transition-colors hover:text-white"
          >
            Close
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1 border-b border-neutral-800 px-3 py-2">
        {(
          ['model', 'remote', 'image', 'voice', 'transcription', 'tools', 'connectors'] as const
        ).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`shrink-0 rounded-md px-3 py-1 text-xs capitalize transition-colors ${tab === t ? 'bg-neutral-800 text-green-500' : 'text-neutral-500 hover:text-neutral-300'}`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className={embedded ? 'p-1 pt-4 text-sm' : 'min-h-0 flex-1 overflow-y-auto p-4 text-sm'}>
        {tab === 'model' && (
          <>
            <div
              className="mb-5 grid grid-cols-2 gap-px border border-neutral-800 bg-neutral-800 lg:grid-cols-4"
              role="status"
            >
              {[
                ['Current model', activeModelName ?? 'No active model'],
                ['Configured', formatContextWindow(s.ctxSize) ?? 'Checking'],
                ['Running', formatContextWindow(s.effectiveCtxSize) ?? 'Checking'],
                [
                  'Recommended',
                  formatContextWindow(recommendedContextWindow(s.modelMaxCtx)) ?? 'Not supported'
                ]
              ].map(([label, value]) => (
                <div key={label} className="bg-neutral-950/90 p-3">
                  <div className="text-[10px] uppercase tracking-wide text-neutral-600">
                    {label}
                  </div>
                  <div className="mt-1 truncate text-xs text-neutral-200" title={value}>
                    {value}
                  </div>
                </div>
              ))}
            </div>
            <p className="mb-5 text-[11px] leading-5 text-neutral-500">
              16K is recommended for capture and chat. Capture needs at least 8K; smaller windows
              can save memory but leave captured frames waiting for analysis.
            </p>
            <Row
              label="Temperature"
              value={(s.temperature ?? 0.7).toFixed(2)}
              hint="Lower = focused, higher = creative."
            >
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.05}
                value={s.temperature ?? 0.7}
                onChange={(e) => set({ temperature: Number(e.target.value) })}
                className="w-full accent-green-500"
              />
            </Row>
            <Row label="Top-P" value={(s.topP ?? 0.95).toFixed(2)} hint="Nucleus sampling cutoff.">
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={s.topP ?? 0.95}
                onChange={(e) => set({ topP: Number(e.target.value) })}
                className="w-full accent-green-500"
              />
            </Row>
            <Row
              label="Top-K"
              value={String(s.topK ?? 40)}
              hint="0 disables. Limits candidate tokens."
            >
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={s.topK ?? 40}
                onChange={(e) => set({ topK: Number(e.target.value) })}
                className="w-full accent-green-500"
              />
            </Row>
            <Row
              label="Min-P"
              value={(s.minP ?? 0.05).toFixed(2)}
              hint="Min probability relative to the top token."
            >
              <input
                type="range"
                min={0}
                max={0.5}
                step={0.01}
                value={s.minP ?? 0.05}
                onChange={(e) => set({ minP: Number(e.target.value) })}
                className="w-full accent-green-500"
              />
            </Row>
            <Row
              label="Repeat penalty"
              value={(s.repeatPenalty ?? 1.1).toFixed(2)}
              hint="Higher discourages repetition."
            >
              <input
                type="range"
                min={1}
                max={1.5}
                step={0.01}
                value={s.repeatPenalty ?? 1.1}
                onChange={(e) => set({ repeatPenalty: Number(e.target.value) })}
                className="w-full accent-green-500"
              />
            </Row>
            {/* Order matters: the OUTER budget first, because each inner one is bounded by it.
                thinking budget within max output within context window (rule in @offgrid/models). */}
            <Row label="Context window" controlId="context-window" hint={contextWindowHint(s)}>
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
                onValueChange={(value) => set(budgetChange(s, { reasoningBudget: Number(value) }))}
                options={[
                  REASONING_BUDGET_AUTO,
                  ...optionsWithinCeiling(REASONING_BUDGET_OPTIONS, thinkingCeiling(s))
                ].map((value) => ({ value: String(value), label: reasoningBudgetLabel(value) }))}
              />
            </Row>
            <Row
              label="System prompt"
              hint="Prepended to every chat as a system message. Leave blank for the default."
            >
              <textarea
                value={s.systemPrompt ?? ''}
                onChange={(e) => set({ systemPrompt: e.target.value })}
                rows={5}
                placeholder="e.g. You are a concise, technical assistant."
                className="w-full resize-none rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-neutral-200 placeholder-neutral-600 outline-none focus:border-green-500"
              />
            </Row>

            {/* Advanced — launch-time params; changing any reloads the model. */}
            <div className="mb-3 mt-6 border-t border-neutral-800 pt-4 text-[10px] font-medium uppercase tracking-widest text-neutral-600">
              Advanced (reloads the model)
            </div>
            <Row
              label="KV cache"
              hint="Quantize the KV cache to cut memory and allow a larger context. q8_0 ≈ half, q4_0 ≈ quarter of f16. Auto-enables FlashAttention."
            >
              <div className="flex gap-1.5">
                {(['f16', 'q8_0', 'q4_0'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() =>
                      set({ kvCacheType: t, ...(t !== 'f16' ? { flashAttn: true } : {}) })
                    }
                    className={`flex-1 rounded-md border px-2 py-1.5 text-xs transition-colors ${(s.kvCacheType ?? 'f16') === t ? 'border-green-500 text-green-500' : 'border-neutral-800 text-neutral-400 hover:border-neutral-700'}`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </Row>
            <Row
              label="FlashAttention"
              value={(s.flashAttn ?? false) ? 'On' : 'Off'}
              hint="Faster, lower memory. Required for a quantized KV cache."
            >
              <button
                onClick={() => set({ flashAttn: !(s.flashAttn ?? false) })}
                disabled={(s.kvCacheType ?? 'f16') !== 'f16'}
                className={`w-full rounded-md border px-2 py-1.5 text-xs transition-colors disabled:opacity-50 ${s.flashAttn ? 'border-green-500 text-green-500' : 'border-neutral-800 text-neutral-400 hover:border-neutral-700'}`}
              >
                {s.flashAttn ? 'Enabled' : 'Disabled'}
              </button>
            </Row>
            <Row
              label="GPU layers"
              value={String(s.gpuLayers ?? 99)}
              hint={gpuLayersHint(s.gpuAccelerator ?? null)}
            >
              <input
                type="range"
                min={0}
                max={99}
                step={1}
                value={s.gpuLayers ?? 99}
                onChange={(e) => set({ gpuLayers: Number(e.target.value) })}
                className="w-full accent-green-500"
              />
            </Row>
            <Row
              label="CPU threads"
              value={(s.threads ?? 0) === 0 ? 'auto' : String(s.threads)}
              hint="0 = auto (let llama.cpp choose)."
            >
              <input
                type="range"
                min={0}
                max={16}
                step={1}
                value={s.threads ?? 0}
                onChange={(e) => set({ threads: Number(e.target.value) })}
                className="w-full accent-green-500"
              />
            </Row>
            <Row
              label="Batch size"
              value={String(s.batchSize ?? 512)}
              hint="Tokens processed per batch during prompt ingest."
            >
              <input
                type="range"
                min={64}
                max={2048}
                step={64}
                value={s.batchSize ?? 512}
                onChange={(e) => set({ batchSize: Number(e.target.value) })}
                className="w-full accent-green-500"
              />
            </Row>

            <button
              onClick={resetDefaults}
              className="mt-2 w-full rounded-md border border-neutral-800 px-3 py-2 text-xs text-neutral-400 transition-colors hover:border-neutral-700 hover:text-white"
            >
              Reset to defaults
            </button>
          </>
        )}

        {tab === 'image' && <ImageSettingsTab />}

        {tab === 'remote' && <RemoteVisionSettingsTab />}

        {tab === 'voice' && <VoiceSettingsTab />}

        {tab === 'transcription' && (
          <>
            <Row
              label="Current model"
              controlId="transcription-model"
              hint="The model used for the next recording."
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
              {transcriptionInfo ? (
                <p className="mt-1 text-[10px] text-neutral-600">{transcriptionInfo.label}</p>
              ) : null}
            </Row>
            <Row
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
          </>
        )}

        {tab === 'tools' && (
          <>
            <p className="mb-3 text-[11px] text-neutral-500">
              Built-in tools the model can call when “Tools” is on in the composer.
            </p>
            {tools.length === 0 ? (
              <p className="text-xs text-neutral-600">No tools.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {tools.map((t) => (
                  <div
                    key={t.name}
                    className="flex items-start justify-between gap-3 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div
                        className={`text-sm ${t.enabled === false ? 'text-neutral-500' : 'text-green-500'}`}
                      >
                        {t.name}
                      </div>
                      <div className="text-[11px] text-neutral-500">{t.description}</div>
                    </div>
                    <button
                      onClick={() => {
                        const next = t.enabled === false
                        void persistToggle(
                          tools.map((x) => (x.name === t.name ? { ...x, enabled: next } : x)),
                          tools,
                          setTools,
                          () => window.api.setToolEnabled?.(t.name, next)
                        )
                      }}
                      className={`shrink-0 rounded px-2 py-1 text-[11px] ${t.enabled === false ? 'text-neutral-500' : 'text-green-500'}`}
                    >
                      {t.enabled === false ? 'Off' : 'On'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'connectors' && (
          <>
            <p className="mb-3 text-[11px] text-neutral-500">
              Connect MCP servers — your reusable tool library (web search, fetch, etc.). Add an
              HTTP MCP endpoint:
            </p>
            <div className="mb-4 flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
              <input
                value={newConn.name}
                onChange={(e) => setNewConn({ ...newConn, name: e.target.value })}
                placeholder="Name (e.g. Brave Search)"
                className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-green-500"
              />
              <input
                value={newConn.url}
                onChange={(e) => setNewConn({ ...newConn, url: e.target.value })}
                placeholder="https://… (MCP HTTP URL)"
                className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-green-500"
              />
              <button
                onClick={addConnector}
                disabled={!newConn.name.trim() || !newConn.url.trim()}
                className="self-start rounded-md bg-green-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-green-500 disabled:opacity-40"
              >
                Add connector
              </button>
            </div>
            {connectors.length === 0 ? (
              <p className="text-xs text-neutral-600">No connectors yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {connectors.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm text-neutral-200">{c.name}</div>
                      {c.url ? (
                        <div className="truncate text-[10px] text-neutral-600">{c.url}</div>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={async () => {
                          await window.api.mcpSetEnabled?.(c.id, !c.enabled)
                          refreshConnectors()
                        }}
                        className={`rounded px-2 py-1 text-[11px] ${c.enabled ? 'text-green-500' : 'text-neutral-500'}`}
                      >
                        {c.enabled ? 'On' : 'Off'}
                      </button>
                      <button
                        onClick={async () => {
                          await window.api.mcpRemove?.(c.id)
                          refreshConnectors()
                        }}
                        className="rounded px-2 py-1 text-[11px] text-red-400 hover:bg-red-500/10"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
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
      className="w-[calc(30vw+50px)] min-w-[470px]"
    >
      {content}
    </SidePanel>
  )
}
