import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { ProgressiveBlur } from './ui/progressive-blur'
import { SetupPanel } from './setup/SetupPanel'
import { StoragePanel } from './setup/StoragePanel'
import { DataPrivacyPanel } from './setup/DataPrivacyPanel'
import { getRegisteredSettingsSections } from '../bootstrap/sectionRegistry'
import { PRO_SETTINGS_SLOTS } from './pro/proSettingsCatalog'
// Shared card chrome, in its own light module so the pro package can reuse it without
// importing this whole god-file (which pulls SetupPanel/etc. + their window.api types).
import { SettingsCard, ProPlaceholder, SettingsCardsGroup } from './SettingsCard'
import { KeyboardShortcuts } from './KeyboardShortcuts'
import { currentPlatform } from '@renderer/lib/device'
import { proComingSoonHere } from './pro/proCatalog'
import { SoftwareUpdateSection } from './SoftwareUpdateSection'
import { ProcessingControls } from './ProcessingControls'
import { BackupRestoreSection } from './BackupRestoreSection'
import { SettingsPermissionsPanel } from './PermissionsPanel'
export { ModelPipelineSection } from './ProcessingControls'

const SETTINGS_SECTION_TITLES: Record<string, string> = {
  setup: 'Setup & health',
  permissions: 'Setup & health',
  capture: 'Capture & processing',
  sync: 'Device sync',
  identity: 'You',
  secretary: 'What Off Grid has learned',
  'pro-plan': 'Your Pro plan',
  privacy: 'Data & privacy',
  backup: 'Backup & restore',
  shortcuts: 'Keyboard shortcuts',
  update: 'Software update'
}

const SETTINGS_TITLE_IDS = Object.fromEntries(
  Object.entries(SETTINGS_SECTION_TITLES)
    .filter(([id]) => id !== 'permissions')
    .map(([id, title]) => [title, id])
) as Record<string, string>

export function Settings({
  initialSection,
  onInitialSectionConsumed,
  activeSection,
  onSectionChange
}: {
  initialSection?: string | null
  onInitialSectionConsumed?: () => void
  activeSection?: string | null
  onSectionChange?: (section: string | null) => void
} = {}): React.ReactElement {
  const selectedSection = activeSection === undefined ? initialSection : activeSection
  // Pro/core aware: the pro Settings sections (identity / proactive / secretary /
  // plan) render only when the pro package has registered them (section registry);
  // the free build shows the catalogued placeholders. isPro still drives the header
  // subtitle copy.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isPro = !!(window as any).api?.isPro
  const proComingSoon = proComingSoonHere(currentPlatform(), isPro)
  // Pro sections registered by the pro renderer at activation (empty in free build).
  const registeredSections = getRegisteredSettingsSections()
  const captureSection = registeredSections.find((section) => section.id === 'capture')
  const CaptureContribution = captureSection?.component
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window.api as any)
      .getAppVersion?.()
      .then((v: string) => setAppVersion(v || ''))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!selectedSection) return
    const timer = window.setTimeout(() => {
      if (selectedSection === 'permissions') {
        const target: {
          scrollIntoView?: (options?: ScrollIntoViewOptions) => void
        } | null = document.getElementById('settings-permissions')
        target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      }
      onInitialSectionConsumed?.()
    }, 350)
    return () => window.clearTimeout(timer)
  }, [selectedSection, onInitialSectionConsumed])

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
          className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2 2xl:grid-cols-3"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
        >
          {/* Grid of section cards; clicking one opens it as a full-width L2 detail
              (single-open) and hides the rest — one seam via SettingsCardsGroup. */}
          <SettingsCardsGroup
            initialOpenId={selectedSection ? SETTINGS_SECTION_TITLES[selectedSection] : null}
            openId={
              onSectionChange
                ? selectedSection
                  ? (SETTINGS_SECTION_TITLES[selectedSection] ?? null)
                  : null
                : undefined
            }
            onOpenIdChange={(title) =>
              onSectionChange?.(title ? (SETTINGS_TITLE_IDS[title] ?? null) : null)
            }
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
              {isPro && currentPlatform() === 'darwin' ? (
                <section id="settings-permissions" className="mt-6 scroll-mt-4">
                  <div className="mb-3 text-[10px] font-medium uppercase tracking-widest text-neutral-600">
                    System permissions
                  </div>
                  <SettingsPermissionsPanel />
                </section>
              ) : null}
            </SettingsCard>

            <SettingsCard
              title="Capture & processing"
              summary="See capture health, recover pending frames, and control model scheduling in one place."
              delay={0.14}
            >
              {CaptureContribution && !(proComingSoon && currentPlatform() !== 'darwin') ? (
                <CaptureContribution />
              ) : (
                <div className="mb-5 border border-neutral-800 bg-neutral-950/40 p-3 text-xs text-neutral-500">
                  <span className="mr-2 text-[10px] uppercase tracking-wide text-emerald-500">
                    Pro
                  </span>
                  Screen capture, backlog recovery, and proactive delivery are available with Pro on
                  macOS.
                </div>
              )}
              <ProcessingControls />
            </SettingsCard>

            {/* Remaining Pro Settings sections (You / What Off Grid has learned /
              Your Pro plan). The pro package registers the real section
              components via the section registry; the free build shows the catalogued
              placeholders. Slot list, order, and placeholder copy live in
              proSettingsCatalog — core owns the inert shell, pro owns the logic. */}
            {PRO_SETTINGS_SLOTS.filter(
              (slot) => slot.id !== 'capture' && slot.id !== 'proactive'
            ).map((slot) => {
              const section = registeredSections.find((s) => s.id === slot.id)
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

            {/* Data & privacy — one place to delete on-device data. */}
            <SettingsCard
              title="Data & privacy"
              summary="See and delete on-device data, per category or all at once."
              delay={0.42}
            >
              <DataPrivacyPanel />
            </SettingsCard>

            <SettingsCard
              title="Backup & restore"
              summary="Save a portable copy of your chats, projects, and knowledge files."
              delay={0.44}
            >
              <BackupRestoreSection />
            </SettingsCard>

            {/* Keyboard shortcuts — one reference for every hotkey (core + pro rows). */}
            <SettingsCard
              title="Keyboard shortcuts"
              summary="Every hotkey in one place — command palette, navigation, clipboard, dictation."
              delay={0.45}
            >
              <KeyboardShortcuts />
            </SettingsCard>

            {/* Software update — check for updates + automatic-update control (core). */}
            <SettingsCard
              title="Software update"
              summary="Check for updates and choose whether they install automatically."
              delay={0.46}
            >
              <SoftwareUpdateSection />
            </SettingsCard>
          </SettingsCardsGroup>

          {/* Version footer — so you always know which build you're on. */}
          <div className="col-span-full flex items-center justify-center gap-2 pt-2 text-xs text-neutral-600">
            <span className="font-medium text-neutral-500">Off Grid AI</span>
            {appVersion && <span>v{appVersion}</span>}
          </div>
        </motion.div>
      </div>

      <ProgressiveBlur height="80px" position="bottom" className="pointer-events-none" />
    </div>
  )
}
