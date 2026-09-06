import {
  Globe,
  Desktop,
  Brain,
  DeviceMobile,
  ArrowRight,
  Presentation
} from '@phosphor-icons/react'
import {
  PRESET_SECTIONS,
  type DemoPreset,
  type PresetCapability,
  type PresetRequirement
} from './presetCatalog'

/**
 * The Explore surface: the demo-preset catalog rendered as capability panels, each holding a
 * dense grid of runnable cards. A card shows the capability label + blurb only - never the raw
 * prompt; that stays behind the tap.
 *
 * Tapping a card calls `onRun(preset)` - the host opens a real chat with the preset's intake form.
 * The form collects the complete brief before one detailed prompt is sent. Container queries keep the
 * same component backs the chat empty state (one panel column) and the Explore screen (two).
 * Data comes from presetCatalog (the SSOT).
 */

const CAPABILITY_ICON: Record<PresetCapability, typeof Globe> = {
  browser: Globe,
  'computer-use': Desktop,
  creation: Presentation,
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
  /** Configure a preset: the host opens its intake form in Chat. */
  onRun: (preset: DemoPreset) => void
  /** Where "Request a capability" points (a Google Form for now). Omit to hide the link. */
  requestUrl?: string
  /** Hide the built-in intro when the host renders its own header (the Explore screen). */
  showIntro?: boolean
  className?: string
}

export function ExploreSection({
  onRun,
  requestUrl,
  showIntro = true,
  className = ''
}: ExploreSectionProps): React.ReactElement {
  return (
    <div className={`@container font-mono ${className}`}>
      {showIntro ? (
        <div className="mb-4">
          <h2 className="text-sm text-foreground">Explore what Off Grid AI can do</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Pick one - add the details once, then start the run. Everything runs on your Mac.
          </p>
        </div>
      ) : null}

      <div className="columns-1 gap-3 @4xl:columns-2">
        {PRESET_SECTIONS.map((section) => {
          const Icon = CAPABILITY_ICON[section.capability]
          return (
            <section
              key={section.id}
              className="mb-3 break-inside-avoid rounded-md border border-border bg-card p-3 text-card-foreground"
            >
              <div className="mb-3 flex items-center gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-primary">
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-[13px] text-foreground">{section.title}</h3>
                  <p className="truncate text-[11px] text-muted-foreground">{section.teaches}</p>
                </div>
                <span className="shrink-0 self-start text-[9px] uppercase tracking-wide text-muted-foreground">
                  {section.presets.length} {section.presets.length === 1 ? 'run' : 'runs'}
                </span>
              </div>

              <div className="grid grid-cols-1 gap-2 @2xl:grid-cols-2">
                {section.presets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => onRun(preset)}
                    className="group grid min-h-28 grid-cols-[1.5rem_minmax(0,1fr)_1rem] gap-x-2 rounded-md border border-border bg-background p-3 text-left text-foreground transition-all duration-150 hover:border-primary/50 hover:bg-accent active:scale-[0.99]"
                    data-testid={`explore-preset-${preset.id}`}
                  >
                    <preset.icon className="mt-0.5 h-[18px] w-[18px] shrink-0 text-muted-foreground transition-colors duration-150 group-hover:text-primary" />
                    <div className="min-w-0">
                      <span className="block text-xs text-foreground transition-colors duration-150">
                        {preset.title}
                      </span>
                      <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
                        {preset.blurb}
                      </span>
                    </div>
                    <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 -translate-x-0.5 text-muted-foreground/60 transition-all duration-150 group-hover:translate-x-0 group-hover:text-primary" />
                    <div className="col-start-2 mt-2">
                      {preset.requires ? (
                        <span className="inline-block rounded-sm bg-muted px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
                          {REQUIREMENT_LABEL[preset.requires]}
                        </span>
                      ) : preset.readiness === 'robust' ? (
                        <span className="inline-flex items-center gap-1.5 text-[9px] uppercase tracking-wide text-muted-foreground">
                          <span className="h-1 w-1 rounded-full bg-primary" />
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

      {requestUrl ? (
        <a
          href={requestUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-primary"
        >
          Not seeing what you need? Request a capability
          <ArrowRight className="h-3 w-3" />
        </a>
      ) : null}
    </div>
  )
}
