import { useState } from 'react'
import {
  Globe,
  Desktop,
  Brain,
  DeviceMobile,
  ArrowRight,
  Lightbulb,
  PaperPlaneTilt,
  Copy,
  Check
} from '@phosphor-icons/react'
import {
  PRESET_SECTIONS,
  SUPPORT_EMAIL,
  buildWorkflowRequestMailto,
  type DemoPreset,
  type PresetCapability,
  type PresetRequirement
} from './presetCatalog'
import { openExternal } from '../../constants/links'
import { writeClipboardWithFallback } from '../../lib/clipboard-write'

/**
 * The Explore surface: the demo-preset catalog rendered as capability panels, each holding a
 * dense grid of runnable cards. A card shows the capability label + blurb only - never the raw
 * prompt; that stays behind the tap.
 *
 * Tapping a card calls `onRun(preset)` - the host seeds a real chat with the preset's prompt
 * so the agent asks its own follow-ups and acts. Placement-agnostic via container queries: the
 * same component backs the chat empty state (one panel column) and the Explore screen (two).
 * Data comes from presetCatalog (the SSOT).
 */

const CAPABILITY_ICON: Record<PresetCapability, typeof Globe> = {
  browser: Globe,
  'computer-use': Desktop,
  memory: Brain,
  phone: DeviceMobile
}

/** Why a preset can't just run yet, said plainly so the card never dead-ends silently. */
const REQUIREMENT_LABEL: Record<PresetRequirement, string> = {
  pro: 'Pro',
  'phone-paired': 'Needs a paired phone',
  'capture-history': 'Needs some capture history'
}

interface ExploreSectionProps {
  /** Run a preset: the host seeds a new chat with `preset.prompt`. */
  onRun: (preset: DemoPreset) => void
  /** Ask for a workflow we don't have yet. Defaults to opening a pre-filled email
   *  to support; injectable so tests don't hit the mail client. */
  onRequestWorkflow?: () => void
  /** Hide the built-in intro when the host renders its own header (the Explore screen). */
  showIntro?: boolean
  className?: string
}

export function ExploreSection({
  onRun,
  onRequestWorkflow,
  showIntro = true,
  className = ''
}: ExploreSectionProps): React.ReactElement {
  const [copiedEmail, setCopiedEmail] = useState(false)
  // Not everyone has a default mail client (webmail users, no mailto handler, an
  // unconfigured Mail.app), so the address is always shown and copyable.
  const copyEmail = async (): Promise<boolean> => {
    const api = window.api as { writeClipboardText?: (s: string) => Promise<boolean> }
    const ok = await writeClipboardWithFallback(SUPPORT_EMAIL, api.writeClipboardText, (t) =>
      navigator.clipboard.writeText(t)
    )
    if (ok) {
      setCopiedEmail(true)
      setTimeout(() => setCopiedEmail(false), 2000)
    }
    return ok
  }
  // The primary action can't be a dead click: mailto silently no-ops when the OS
  // has no mail client, so it also copies the address and confirms - the click
  // always does something useful whether or not a mail app opens.
  const requestWorkflow =
    onRequestWorkflow ??
    (() => {
      openExternal(buildWorkflowRequestMailto())
      void copyEmail()
    })
  return (
    <div className={`@container font-mono ${className}`}>
      {showIntro ? (
        <div className="mb-4">
          <h2 className="text-sm text-white">Explore what Off Grid AI can do</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Pick one - it starts a chat and asks you the rest. Everything runs on your Mac.
          </p>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 @4xl:grid-cols-2">
        {PRESET_SECTIONS.map((section) => {
          const Icon = CAPABILITY_ICON[section.capability]
          return (
            <section
              key={section.id}
              className="flex flex-col rounded-md border border-neutral-800 bg-neutral-900/20 p-3"
            >
              <div className="mb-3 flex items-center gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-neutral-800 bg-neutral-950 text-green-500">
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-[13px] text-white">{section.title}</h3>
                  <p className="truncate text-[11px] text-neutral-500">{section.teaches}</p>
                </div>
                <span className="shrink-0 self-start text-[9px] uppercase tracking-wide text-neutral-600">
                  {section.presets.length} {section.presets.length === 1 ? 'run' : 'runs'}
                </span>
              </div>

              <div className="grid flex-1 grid-cols-1 gap-2 @md:grid-cols-2">
                {section.presets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => onRun(preset)}
                    className="group flex flex-col rounded-md border border-neutral-800 bg-neutral-950 p-3 text-left transition-all duration-150 hover:border-neutral-700 hover:bg-neutral-900/60 active:scale-[0.98]"
                    data-testid={`explore-preset-${preset.id}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <preset.icon className="h-[18px] w-[18px] shrink-0 text-neutral-400 transition-colors duration-150 group-hover:text-green-500" />
                      <ArrowRight className="h-3.5 w-3.5 shrink-0 -translate-x-0.5 text-neutral-700 transition-all duration-150 group-hover:translate-x-0 group-hover:text-green-500" />
                    </div>
                    <span className="mt-2 text-xs text-neutral-100 transition-colors duration-150 group-hover:text-white">
                      {preset.title}
                    </span>
                    <span className="mt-1 text-[11px] leading-4 text-neutral-500">
                      {preset.blurb}
                    </span>
                    <div className="mt-auto pt-2">
                      {preset.requires ? (
                        <span className="inline-block rounded-sm bg-neutral-800/80 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-neutral-400">
                          {REQUIREMENT_LABEL[preset.requires]}
                        </span>
                      ) : preset.readiness === 'robust' ? (
                        <span className="inline-flex items-center gap-1.5 text-[9px] uppercase tracking-wide text-neutral-600">
                          <span className="h-1 w-1 rounded-full bg-green-500" />
                          Ready to run
                        </span>
                      ) : null}
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )
        })}
      </div>

      <div className="mt-4 rounded-md border border-neutral-800 bg-neutral-900/20 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-neutral-800 bg-neutral-950 text-green-500">
              <Lightbulb className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] text-white">Want a workflow we don&apos;t have yet?</div>
              <p className="text-[11px] text-neutral-500">
                Tell us what you&apos;d automate - it goes straight to the team.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={requestWorkflow}
            data-testid="explore-request-workflow"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] transition-all duration-150 active:scale-95 border-neutral-700 text-neutral-300 hover:border-green-500 hover:text-green-500"
          >
            {copiedEmail ? (
              <>
                <Check className="h-3.5 w-3.5 text-green-500" weight="bold" />
                Email address copied
              </>
            ) : (
              <>
                <PaperPlaneTilt className="h-3.5 w-3.5" />
                Request a workflow
              </>
            )}
          </button>
        </div>
        <div className="mt-2.5 flex items-center gap-2 border-t border-neutral-800/60 pt-2.5">
          <span className="text-[11px] text-neutral-500">Or email us at</span>
          <span
            className="select-text text-[11px] text-neutral-200"
            data-testid="explore-support-email"
          >
            {SUPPORT_EMAIL}
          </span>
          <button
            type="button"
            onClick={copyEmail}
            data-testid="explore-copy-email"
            aria-label="Copy the support email address"
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200"
          >
            {copiedEmail ? (
              <Check className="h-3 w-3 text-green-500" weight="bold" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
            {copiedEmail ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  )
}
