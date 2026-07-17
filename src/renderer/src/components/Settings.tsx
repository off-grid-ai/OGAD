import { useEffect, useState } from 'react'
import { persistToggle } from '@renderer/lib/persist-toggle'
import { motion } from 'motion/react'
import { ProgressiveBlur } from './ui/progressive-blur'
import { SetupPanel } from './setup/SetupPanel'
import { StoragePanel } from './setup/StoragePanel'
import { DataPrivacyPanel } from './setup/DataPrivacyPanel'
import { useCoreSettingsSections, useProSettingsSections } from '../bootstrap/sectionRegistry'
import { PRO_SETTINGS_SLOTS } from './pro/proSettingsCatalog'
// Shared card chrome, in its own light module so the pro package can reuse it without
// importing this whole god-file (which pulls SetupPanel/etc. + their window.api types).
import { SettingsCard, ProPlaceholder } from './SettingsCard'
import { currentPlatform } from '@renderer/lib/device'
import { proComingSoonHere } from './pro/proCatalog'

// ---------------------------------------------------------------------------
// Software update — current version, manual check, automatic-update toggle
// ---------------------------------------------------------------------------

// Runtime residency — per-engine on-demand vs in-memory (core infra). On a 16GB
// Mac keeping a model warm trades RAM for latency; the queue evicts a warm model
// when another engine needs the memory, so 'resident' is safe to opt into.
const RESIDENCY_ROWS: {
  modality: 'llm' | 'image' | 'stt' | 'tts'
  label: string
  hint: string
  locked?: boolean
}[] = [
  {
    modality: 'llm',
    label: 'Chat model',
    locked: true,
    hint: 'The local LLM (gemma). Kept in memory because screen replay distills captures through it continuously - on-demand would thrash-reload ~5GB. It is still freed momentarily during image generation, then reloaded.'
  },
  {
    modality: 'image',
    label: 'Image generation',
    hint: 'Resident keeps the diffusion model warm (~45s cold to ~7s warm); on-demand frees it after each image.'
  },
  {
    modality: 'stt',
    label: 'Dictation (speech-to-text)',
    hint: 'Resident keeps Whisper warm for fast live text; on-demand loads per recording. Parakeet always loads per use.'
  },
  {
    modality: 'tts',
    label: 'Text-to-speech',
    hint: 'Resident keeps the voice model warm; on-demand frees ~330MB between phrases.'
  }
]

function RuntimeResidencySection(): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (window as any).api
  const [modes, setModes] = useState<Record<string, string>>({})
  useEffect(() => {
    api
      .residencyGet?.()
      .then((m: Record<string, string>) => setModes(m))
      .catch(() => {})
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [])
  const toggle = (modality: string, locked?: boolean): void => {
    if (locked) return // locked modalities (chat model) stay in-memory — no toggle
    const nextMode = modes[modality] === 'resident' ? 'on-demand' : 'resident'
    void persistToggle({ ...modes, [modality]: nextMode }, modes, setModes, () =>
      api.residencySet?.(modality, nextMode)
    )
  }
  return (
    <div>
      <p className="text-neutral-500 text-sm mb-4">
        Keep a model in memory for instant use, or load it on demand to free RAM. Only one heavy
        model runs at a time - when another engine needs the memory, a resident model is evicted and
        reloaded on its next use, so resident mode never hangs the machine. On-demand is the safe
        default on 16GB Macs.
      </p>
      <div className="flex flex-col divide-y divide-neutral-800">
        {RESIDENCY_ROWS.map((row) => {
          const resident = row.locked || modes[row.modality] === 'resident'
          return (
            <div
              key={row.modality}
              className="flex items-start justify-between gap-4 py-3 first:pt-0"
            >
              <div>
                <div className="text-sm text-neutral-200">{row.label}</div>
                <div className="text-xs text-neutral-600">{row.hint}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={`text-[11px] tabular-nums ${resident ? 'text-emerald-400' : 'text-neutral-500'}`}
                >
                  {row.locked ? 'in-memory (required)' : resident ? 'in-memory' : 'on-demand'}
                </span>
                <button
                  onClick={() => toggle(row.modality, row.locked)}
                  role="switch"
                  aria-checked={resident}
                  aria-disabled={row.locked}
                  disabled={row.locked}
                  title={
                    row.locked
                      ? 'Required in memory - screen replay depends on this model'
                      : undefined
                  }
                  aria-label={`${row.label} residency`}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${resident ? 'bg-emerald-500' : 'bg-neutral-700'} ${row.locked ? 'cursor-not-allowed opacity-50' : ''}`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${resident ? 'translate-x-6' : 'translate-x-1'}`}
                  />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SoftwareUpdateSection(): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (window as any).api
  const [auto, setAuto] = useState(true)
  const [beta, setBeta] = useState(false)
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)
  const [status, setStatus] = useState('')
  useEffect(() => {
    api
      .updateGetPrefs?.()
      .then((p: { currentVersion?: string; auto?: boolean; channel?: string }) => {
        setVersion(p.currentVersion ?? '')
        setAuto(p.auto !== false)
        setBeta(p.channel === 'beta')
      })
      .catch(() => {})
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [])
  const toggle = (): void => {
    void persistToggle(!auto, auto, setAuto, (v) => api.updateSetAuto?.(v))
  }
  const toggleBeta = (): void => {
    const next = !beta
    void persistToggle(next, beta, setBeta, () => api.updateSetChannel?.(next ? 'beta' : 'stable'))
    setStatus(
      next
        ? 'Switched to nightly builds — these ship on every change and are pre-release. Turn this off to return to stable.'
        : 'Back on stable builds. You will move to the latest stable version on the next check.'
    )
  }
  const check = async (): Promise<void> => {
    setChecking(true)
    setStatus('Checking for updates...')
    try {
      const r = await api.checkForUpdates?.()
      if (!r) setStatus('Could not check right now.')
      else if (r.status === 'available')
        setStatus(
          `Update ${r.version} found. Downloading in the background - you'll get a "Restart to update" prompt when it's ready.`
        )
      else if (r.status === 'not-available')
        setStatus(`You're on the latest version (v${r.version}).`)
      else setStatus(`Could not check: ${r.error}`)
    } catch {
      setStatus('Could not check right now.')
    } finally {
      setChecking(false)
    }
  }
  // Body only — the card chrome + title come from SettingsCard.
  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <p className="text-neutral-500 text-sm">
          Off Grid checks for updates in the background and installs them when you quit. Turn this
          off to update only when you choose.
        </p>
        <button
          onClick={toggle}
          role="switch"
          aria-checked={auto}
          className={`relative mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${auto ? 'bg-emerald-500' : 'bg-neutral-700'}`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${auto ? 'translate-x-6' : 'translate-x-1'}`}
          />
        </button>
      </div>
      <div className="mt-4 flex items-start justify-between gap-4 border-t border-neutral-800 pt-4">
        <p className="text-neutral-500 text-sm">
          Get nightly builds. New features land here first, on every change, before they reach
          stable. These are pre-release - expect rough edges. Off by default.
        </p>
        <button
          onClick={toggleBeta}
          role="switch"
          aria-checked={beta}
          className={`relative mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${beta ? 'bg-emerald-500' : 'bg-neutral-700'}`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${beta ? 'translate-x-6' : 'translate-x-1'}`}
          />
        </button>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={check}
          disabled={checking}
          className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-200 transition-colors hover:border-neutral-500 disabled:opacity-60"
        >
          {checking ? 'Checking...' : 'Check for updates'}
        </button>
        {version && <span className="text-xs text-neutral-600">Current: v{version}</span>}
      </div>
      {status && <p className="mt-2 text-xs text-neutral-500">{status}</p>}
    </div>
  )
}

export function Settings() {
  // Pro/core aware: the pro Settings sections (identity / proactive / secretary /
  // plan) render only when the pro package has registered them (section registry);
  // the free build shows the catalogued placeholders. isPro still drives the header
  // subtitle copy.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isPro = !!(window as any).api?.isPro
  const proComingSoon = proComingSoonHere(currentPlatform(), isPro)
  // Pro sections registered by the pro renderer at activation (empty in free build).
  const registeredProSections = useProSettingsSections()
  const packageSections = useCoreSettingsSections()
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window.api as any)
      .getAppVersion?.()
      .then((v: string) => setAppVersion(v || ''))
      .catch(() => {})
  }, [])

  return (
    <div className="relative flex h-full flex-col">
      {/* Fixed header — stays put while the content below scrolls. */}
      <div className="flex shrink-0 items-center gap-3 border-b border-neutral-800/60 px-1 pb-4">
        <div className="h-10 w-10 rounded-xl bg-neutral-800 border border-neutral-700 flex items-center justify-center">
          <svg
            className="w-5 h-5 text-neutral-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white">Settings</h2>
          <p className="text-sm text-neutral-500">
            {isPro
              ? 'Who you are, what Off Grid has learned, and your devices'
              : 'Personalization & automation unlock with Pro'}
          </p>
        </div>
      </div>

      {/* Scrolling content below the fixed header */}
      <div className="relative flex-1 overflow-y-auto px-1 pt-5 pb-16">
        <motion.div
          className="flex flex-col gap-6"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
        >
          {/* Each section is a collapsed-by-default accordion (SettingsCard). */}
          <SettingsCard
            title="Setup & health"
            summary="Set up your local AI, manage storage, and see live component health."
            delay={0.13}
          >
            <SetupPanel />
            <div className="mt-4">
              <StoragePanel />
            </div>
          </SettingsCard>

          {/* Pro Settings sections (You / Proactive delivery / What Off Grid has
              learned / Your Pro plan). The pro package registers the real section
              components via the section registry; the free build shows the catalogued
              placeholders. Slot list, order, and placeholder copy live in
              proSettingsCatalog — core owns the inert shell, pro owns the logic. */}
          {PRO_SETTINGS_SLOTS.map((slot) => {
            const section = registeredProSections.find((registered) => registered.id === slot.id)
            if (section && proComingSoon && slot.macOnly) {
              return (
                <ProPlaceholder
                  key={slot.id}
                  delay={slot.delay}
                  title={slot.placeholder?.title ?? slot.id}
                  description={slot.comingSoonDescription ?? 'Support is coming soon.'}
                  variant="coming-soon"
                />
              )
            }
            if (section) {
              const Section = section.component
              return <Section key={slot.id} />
            }
            if (!slot.placeholder) return null
            return (
              <ProPlaceholder
                key={slot.id}
                delay={slot.delay}
                title={slot.placeholder.title}
                description={slot.placeholder.description}
              />
            )
          })}

          {/* Core packages register their settings sections directly. They do not
              participate in the Pro placeholder or entitlement catalogue. */}
          {packageSections.map((section) => {
            const Section = section.component
            return <Section key={section.id} />
          })}

          {/* Data & privacy — one place to delete on-device data. */}
          <SettingsCard
            title="Data & privacy"
            summary="See and delete on-device data, per category or all at once."
            delay={0.42}
          >
            <DataPrivacyPanel />
          </SettingsCard>

          {/* Runtime residency — per-engine in-memory vs on-demand (core infra). */}
          <SettingsCard
            title="Model memory"
            summary="Keep each engine warm for speed, or load on demand to free RAM."
            delay={0.44}
          >
            <RuntimeResidencySection />
          </SettingsCard>

          {/* Software update — check for updates + automatic-update control (core). */}
          <SettingsCard
            title="Software update"
            summary="Check for updates and choose whether they install automatically."
            delay={0.46}
          >
            <SoftwareUpdateSection />
          </SettingsCard>

          {/* Version footer — so you always know which build you're on. */}
          <div className="flex items-center justify-center gap-2 pt-2 text-xs text-neutral-600">
            <span className="font-medium text-neutral-500">Off Grid AI</span>
            {appVersion && <span>v{appVersion}</span>}
          </div>
        </motion.div>
      </div>

      <ProgressiveBlur height="80px" position="bottom" className="pointer-events-none" />
    </div>
  )
}
