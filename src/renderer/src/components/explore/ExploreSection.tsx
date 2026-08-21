import { Globe, Desktop, Brain, DeviceMobile, ArrowRight } from '@phosphor-icons/react'
import {
  PRESET_SECTIONS,
  type DemoPreset,
  type PresetCapability,
  type PresetRequirement
} from './presetCatalog'

/**
 * The Explore surface: the demo-preset catalog rendered as capability-grouped cards.
 *
 * Tapping a card calls `onRun(preset)` - the host seeds a real chat with the preset's prompt
 * so the agent asks its own follow-ups and acts. Placement-agnostic: the same component backs
 * the chat empty state and the landing card. Data comes from presetCatalog (the SSOT).
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
  /** Where "Request a capability" points (a Google Form for now). Omit to hide the link. */
  requestUrl?: string
  className?: string
}

export function ExploreSection({
  onRun,
  requestUrl,
  className = ''
}: ExploreSectionProps): React.ReactElement {
  return (
    <div className={`font-mono ${className}`}>
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-white">Explore what Off Grid AI can do</h2>
        <p className="mt-0.5 text-xs text-neutral-500">
          Pick one - it starts a chat and asks you the rest. Everything runs on your Mac.
        </p>
      </div>

      <div className="flex flex-col gap-5">
        {PRESET_SECTIONS.map((section) => {
          const Icon = CAPABILITY_ICON[section.capability]
          return (
            <section key={section.id}>
              <div className="mb-2 flex items-baseline gap-2">
                <Icon className="h-4 w-4 shrink-0 text-green-500" />
                <h3 className="text-[13px] text-neutral-200">{section.title}</h3>
                <span className="truncate text-[11px] text-neutral-600">{section.teaches}</span>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {section.presets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => onRun(preset)}
                    className="group flex flex-col gap-1 rounded-md border border-neutral-800 bg-neutral-950 p-3 text-left transition-all duration-150 hover:border-green-500 active:scale-[0.98]"
                    data-testid={`explore-preset-${preset.id}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs text-neutral-100">{preset.title}</span>
                      <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-700 transition-colors group-hover:text-green-500" />
                    </div>
                    <span className="text-[11px] leading-4 text-neutral-500">{preset.blurb}</span>
                    {preset.requires ? (
                      <span className="mt-0.5 w-fit rounded-sm border border-neutral-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-neutral-500">
                        {REQUIREMENT_LABEL[preset.requires]}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            </section>
          )
        })}
      </div>

      {requestUrl ? (
        <a
          href={requestUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-5 inline-flex items-center gap-1.5 text-[11px] text-neutral-500 transition-colors hover:text-green-500"
        >
          Not seeing what you need? Request a capability
          <ArrowRight className="h-3 w-3" />
        </a>
      ) : null}
    </div>
  )
}
