import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IconMicrophone,
  IconDownload,
  IconLoader2,
  IconCircleCheck,
  IconTrash,
  IconWaveSine,
  IconFingerprint,
  IconDeviceMobile
} from '@tabler/icons-react'

/**
 * Voice recognition model management for the Mac. A bundle is two layers: a shared **speaker
 * separation** (pyannote segmentation) model and a **voice fingerprint** (speaker-embedding) model.
 * They run natively in-process (sherpa-onnx) for Day recordings the phone offloads here.
 *
 * The phone is the single source of truth for WHICH fingerprint is active — each offload request names
 * it and the Mac auto-downloads it if missing. So this card doesn't pick an active model; it just shows
 * what's installed and lets you pre-download or remove models. No way to get out of sync with the phone.
 */
interface VoiceModelInfo {
  id: string
  name: string
  embeddingDim: number
  recommended: boolean
  installed: boolean
  active: boolean
}
interface VoiceModelStatus {
  ready: boolean
  segmentation: boolean
  activeModelId: string
  models: VoiceModelInfo[]
}

const bridge = (): typeof window.api => window.api

export function VoiceRecognitionCard(): React.ReactElement {
  const [status, setStatus] = useState<VoiceModelStatus | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ fraction: number; label: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const s = await bridge().getVoiceModelStatus()
      if (mounted.current) setStatus(s)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const off = bridge().onVoiceModelProgress((p) => mounted.current && setProgress(p))
    return () => {
      mounted.current = false
      off()
    }
  }, [refresh])

  const download = useCallback(async (id: string) => {
    setBusyId(id)
    setError(null)
    setProgress({ fraction: 0, label: 'Starting…' })
    try {
      const s = await bridge().installVoiceModels(id)
      if (mounted.current) setStatus(s)
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Download failed.')
    } finally {
      if (mounted.current) {
        setBusyId(null)
        setProgress(null)
      }
    }
  }, [])

  const remove = useCallback(async (id: string) => {
    setBusyId(id)
    setError(null)
    try {
      const s = await bridge().removeVoiceModels(id)
      if (mounted.current) setStatus(s)
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Could not remove.')
    } finally {
      if (mounted.current) setBusyId(null)
    }
  }, [])

  const anyInstalled = status?.models.some((m) => m.installed) ?? false
  const busy = busyId !== null
  const pct = progress ? Math.round(progress.fraction * 100) : 0

  return (
    <div className="mx-6 mt-3 rounded border border-neutral-800 bg-neutral-900/40 p-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded bg-neutral-800/80">
          <IconMicrophone className="h-4 w-4 text-emerald-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-medium text-neutral-200">Voice recognition</h3>
            {status?.ready && (
              <span className="flex items-center gap-1 rounded-sm bg-emerald-500/10 px-1.5 py-0.5 text-[8px] uppercase tracking-wider text-emerald-500">
                <IconCircleCheck className="h-2.5 w-2.5" /> Ready
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[10px] leading-4 text-neutral-500">
            Separates who-spoke-when and recognizes each person&apos;s voice for Day recordings your
            phone offloads here. Runs natively — no Python.
          </p>

          {/* Phone is the source of truth */}
          <div className="mt-2 flex items-center gap-1.5 rounded border border-neutral-800/70 bg-black/20 px-2 py-1.5">
            <IconDeviceMobile className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
            <span className="text-[10px] leading-4 text-neutral-400">
              The active model follows your phone — whichever voice model you pick there is downloaded
              and used here automatically. Pre-download or remove models below.
            </span>
          </div>

          {/* Two layers */}
          <div className="mt-2.5 space-y-2">
            <Layer
              icon={<IconWaveSine className="h-3.5 w-3.5 text-neutral-400" />}
              label="Speaker separation"
              sub="Pyannote segmentation 3.0 — detects who spoke when"
              right={
                status?.segmentation ? (
                  <InstalledTag />
                ) : (
                  <span className="text-[9px] text-neutral-600">installs with a fingerprint</span>
                )
              }
            />

            <div className="rounded border border-neutral-800/70 bg-black/20 p-2">
              <div className="mb-1.5 flex items-center gap-1.5">
                <IconFingerprint className="h-3.5 w-3.5 text-neutral-400" />
                <span className="text-[10px] font-medium text-neutral-300">Voice fingerprints</span>
                <span className="text-[9px] text-neutral-600">— recognizes whose voice</span>
              </div>
              <div className="space-y-1">
                {(status?.models ?? []).map((m) => (
                  <FingerprintRow
                    key={m.id}
                    model={m}
                    busy={busy}
                    busyHere={busyId === m.id}
                    onDownload={() => download(m.id)}
                    onRemove={() => remove(m.id)}
                  />
                ))}
              </div>
            </div>
          </div>

          {busy && progress && (
            <div className="mt-2.5">
              <div className="mb-1 flex items-center justify-between text-[9px] text-neutral-500">
                <span>{progress.label}</span>
                <span className="tabular-nums">{pct}%</span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-neutral-800">
                <div
                  className="h-full origin-left bg-emerald-500 transition-transform duration-150"
                  style={{ transform: `scaleX(${Math.max(0.02, progress.fraction)})` }}
                />
              </div>
            </div>
          )}

          {error && <p className="mt-2 text-[10px] text-red-400">{error}</p>}

          {!anyInstalled && !busy && (
            <p className="mt-2 text-[9px] text-neutral-600">
              Nothing downloaded yet — the first offloaded recording will fetch what your phone uses.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function FingerprintRow({
  model,
  busy,
  busyHere,
  onDownload,
  onRemove
}: {
  model: VoiceModelInfo
  busy: boolean
  busyHere: boolean
  onDownload: () => void
  onRemove: () => void
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-neutral-800/30">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[10px] text-neutral-200">{model.name}</span>
          <span className="text-[9px] text-neutral-600">{model.embeddingDim}-dim</span>
          {model.recommended && (
            <span className="rounded-sm bg-emerald-500/10 px-1 text-[8px] uppercase tracking-wider text-emerald-500">
              Recommended
            </span>
          )}
        </div>
      </div>
      {model.installed ? (
        <>
          <span className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-emerald-500">
            <IconCircleCheck className="h-2.5 w-2.5" /> Installed
          </span>
          <button
            onClick={onRemove}
            disabled={busy}
            aria-label={`Remove ${model.name}`}
            className="rounded border border-neutral-800 p-1 text-neutral-500 transition-all duration-150 hover:border-red-500/50 hover:text-red-400 active:scale-95 disabled:opacity-50"
          >
            {busyHere ? <IconLoader2 className="h-3 w-3 animate-spin" /> : <IconTrash className="h-3 w-3" />}
          </button>
        </>
      ) : (
        <button
          onClick={onDownload}
          disabled={busy}
          className="flex items-center gap-1 rounded border border-emerald-600/50 bg-emerald-500/10 px-2 py-0.5 text-[9px] text-emerald-400 transition-all duration-150 hover:border-emerald-500 hover:bg-emerald-500/15 active:scale-95 disabled:opacity-50"
        >
          {busyHere ? (
            <IconLoader2 className="h-3 w-3 animate-spin" />
          ) : (
            <IconDownload className="h-3 w-3" />
          )}
          Download
        </button>
      )}
    </div>
  )
}

function Layer({
  icon,
  label,
  sub,
  right
}: {
  icon: React.ReactNode
  label: string
  sub: string
  right: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2 rounded border border-neutral-800/70 bg-black/20 p-2">
      {icon}
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-medium text-neutral-300">{label}</div>
        <div className="truncate text-[9px] text-neutral-600">{sub}</div>
      </div>
      {right}
    </div>
  )
}

function InstalledTag(): React.ReactElement {
  return (
    <span className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-emerald-500">
      <IconCircleCheck className="h-2.5 w-2.5" /> Ready
    </span>
  )
}
