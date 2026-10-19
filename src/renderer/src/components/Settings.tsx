import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { ProgressiveBlur } from './ui/progressive-blur'
import { PageHeader, Section } from '@offgrid/operator-ui/operator/experience'
import { Badge } from '@offgrid/operator-ui/operator/coss/badge'
import { SetupPanel } from './setup/SetupPanel'
import { PerformancePackPanel } from './setup/PerformancePackPanel'
import { StoragePanel } from './setup/StoragePanel'
import { DataPrivacyPanel } from './setup/DataPrivacyPanel'
import { getRegisteredSettingsSections } from '../bootstrap/sectionRegistry'
import { useRendererEntitlement } from '../bootstrap/useRendererEntitlement'
import { getSlot, SLOTS } from '../bootstrap/slotRegistry'
import { PRO_SETTINGS_SLOTS } from './pro/proSettingsCatalog'
// Shared card chrome, in its own light module so the pro package can reuse it without
// importing this whole god-file (which pulls SetupPanel/etc. + their window.api types).
import { SettingsCard, ProPlaceholder, SettingsCardsGroup } from './SettingsCard'
import { KeyboardShortcuts } from './KeyboardShortcuts'
import { currentPlatform } from '@renderer/lib/device'
import { getProFeature, proComingSoonHere, featureSupportsPlatform } from './pro/proCatalog'
import { SoftwareUpdateSection } from './SoftwareUpdateSection'
import { ProcessingControls } from './ProcessingControls'
import { BackupRestoreSection } from './BackupRestoreSection'
import { SettingsPermissionsPanel } from './PermissionsPanel'
import { RemoteVisionSettingsTab } from './RemoteVisionSettingsTab'
import { AIRequestLogs } from './AIRequestLogs'
export { ModelPipelineSection } from './ProcessingControls'

const SETTINGS_SECTION_TITLES: Record<string, string> = {
  setup: 'Setup & health',
  permissions: 'Setup & health',
  performance: 'GPU performance',
  capture: 'Capture & processing',
  'computer-use': 'Computer use',
  remote: 'Remote model server',
  'ai-activity': 'AI activity',
  'god-twin': 'God',
  sync: 'Device sync',
  identity: 'You',
  secretary: 'What Off Grid AI has learned',
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

export const SETTINGS_DESTINATIONS = Object.entries(SETTINGS_TITLE_IDS).map(
  ([label, subroute]) => ({ label, view: 'settings', subroute })
)

// Four columns suit a card count whose last row is fuller four-wide than three-wide, so no card
// sits alone on the last row. A count that fills both equally keeps three.
function settingsColumns(cards: number): 3 | 4 {
  const lastRow = (columns: number): number => cards % columns || columns
  return lastRow(4) / 4 > lastRow(3) / 3 ? 4 : 3
}

/** The number of Settings cards actually drawn: sections a build does not ship render nothing, and
 *  full-width rows (the version footer) are not cards. */
function useSettingsColumns(): [React.RefObject<HTMLDivElement | null>, 3 | 4] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [columns, setColumns] = useState<3 | 4>(3)
  useEffect(() => {
    const grid = ref.current
    if (!grid) return
    const count = (): void => {
      const drawn = [...grid.children].filter(
        (child) => child.getClientRects().length > 0 && !child.classList.contains('col-span-full')
      ).length
      setColumns(settingsColumns(drawn))
    }
    count()
    const observer = new MutationObserver(count)
    observer.observe(grid, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'style', 'class']
    })
    return () => observer.disconnect()
  }, [])
  return [ref, columns]
}

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
  const { isPro } = useRendererEntitlement()
  const proComingSoon = proComingSoonHere(currentPlatform(), isPro)
  const replayFeature = getProFeature('replay')
  const captureAvailable =
    !!replayFeature && featureSupportsPlatform(replayFeature, currentPlatform())
  // Pro sections registered by the pro renderer at activation (empty in free build).
  const registeredSections = getRegisteredSettingsSections()
  const captureSection = registeredSections.find((section) => section.id === 'capture')
  const CaptureContribution = captureSection?.component
  // God is Pro: its settings card comes from Pro through a slot, looked up once per opening.
  const [GodSettings] = useState(() => getSlot(SLOTS.godSettings))
  const [appVersion, setAppVersion] = useState('')
  const [gridRef, columns] = useSettingsColumns()

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
      <PageHeader
        className="shrink-0 px-1 pb-6"
        title="Settings"
        description={
          isPro
            ? 'Who you are, what Off Grid AI has learned, and your devices'
            : 'Personalization & automation unlock with Pro'
        }
      />

      {/* Scrolling content below the fixed header */}
      <div className="relative flex-1 overflow-y-auto px-1 pt-2 pb-16">
        <motion.div
          ref={gridRef}
          data-columns={columns}
          className="settings-grid grid grid-cols-1 items-start gap-2 lg:grid-cols-2 xl:grid-cols-3"
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
              <div className="space-y-6">
                <SetupPanel />
                <StoragePanel />
                {currentPlatform() === 'darwin' ? (
                  <div id="settings-permissions" className="scroll-mt-4">
                    <Section label="System permissions">
                      <SettingsPermissionsPanel />
                    </Section>
                  </div>
                ) : null}
              </div>
            </SettingsCard>

            <SettingsCard
              title="GPU performance"
              summary="Manage GPU components for chat, images, transcription, and Computer Use."
              delay={0.135}
            >
              <PerformancePackPanel showUnavailable />
            </SettingsCard>

            <SettingsCard
              title="Capture & processing"
              summary="See capture health, recover pending frames, and control model scheduling in one place."
              delay={0.14}
            >
              {CaptureContribution && captureAvailable ? (
                <CaptureContribution />
              ) : (
                <div className="mb-5 border border-neutral-800 bg-neutral-950/40 p-3 text-xs text-neutral-500">
                  <Badge variant="success" size="sm" className="mr-2">
                    Pro
                  </Badge>
                  {currentPlatform() === 'linux'
                    ? 'Capture and Replay controls are available with Pro on Linux.'
                    : 'Screen capture, backlog recovery, and proactive delivery are available with Pro on Windows, Linux, and macOS.'}
                </div>
              )}
              <ProcessingControls />
            </SettingsCard>

            <SettingsCard
              title="Remote model server"
              summary="Connect to a model server on your network or another trusted host."
              delay={0.16}
            >
              <RemoteVisionSettingsTab />
            </SettingsCard>

            {/* God is Pro: its settings show only where God does. */}
            {isPro && GodSettings && (
              <SettingsCard
                title="God"
                summary="Your assistant's name, rules, wake word and Ares on the desktop."
                delay={0.17}
              >
                <GodSettings />
              </SettingsCard>
            )}

            {/* Remaining Pro Settings sections (You / What Off Grid AI has learned /
              Your Pro plan). The pro package registers the real section
              components via the section registry; the free build shows the catalogued
              placeholders. Slot list, order, and placeholder copy live in
              proSettingsCatalog — core owns the inert shell, pro owns the logic. */}
            {PRO_SETTINGS_SLOTS.filter(
              (slot) => slot.id !== 'capture' && slot.id !== 'proactive'
            ).map((slot) => {
              const section = registeredSections.find((s) => s.id === slot.id)
              if (section && proComingSoon && slot.id !== 'pro-plan') {
                return (
                  <ProPlaceholder
                    key={slot.id}
                    delay={slot.delay}
                    title={slot.placeholder?.title ?? slot.id}
                    description={
                      slot.comingSoonDescription ?? 'This section is unavailable on this device.'
                    }
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
                  variant="pro"
                />
              )
            })}

            {/* Data & privacy — one place to delete on-device data. */}
            <SettingsCard
              title="AI activity"
              summary="Inspect requests, responses, models, and generation details stored on this device."
            >
              <AIRequestLogs />
            </SettingsCard>
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
              summary="Every hotkey in one place: command palette, navigation, window zoom, clipboard, dictation."
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
