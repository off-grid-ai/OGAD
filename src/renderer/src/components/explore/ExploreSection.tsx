import { Globe, Desktop, Brain, DeviceMobile, ArrowRight, Palette } from '@phosphor-icons/react'
import {
  PRESET_SECTIONS,
  type DemoPreset,
  type PresetCapability,
  type PresetRequirement
} from './presetCatalog'
import { Badge } from '@offgrid/operator-ui/operator/coss/badge'
import { Card } from '@offgrid/operator-ui/operator/coss/card'
import { Section } from '@offgrid/operator-ui/operator/experience'
import { AnimatedGroup } from '@offgrid/operator-ui/operator/motion/animated-group'

/**
 * The Explore surface: the demo-preset catalog rendered as capability panels, each holding a
 * compact list of runnable rows. A card shows the capability label + blurb only - never the raw
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
  memory: Brain,
  phone: DeviceMobile,
  creation: Palette
}

/** Why a preset can't just run yet, said plainly so the card never dead-ends silently. */
const REQUIREMENT_LABEL: Record<PresetRequirement, string> = {
  pro: 'Pro',
  'phone-paired': 'Needs a paired phone',
  'capture-history': 'Needs some capture history',
  'image-model': 'Needs an image model'
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
  const panels = (
    <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
      {PRESET_SECTIONS.map((section) => {
        const Icon = CAPABILITY_ICON[section.capability]
        return (
          <Card
            key={section.id}
            render={<section />}
            className="break-inside-avoid gap-4 p-4 @4xl:[&:only-child]:col-span-2"
          >
            <div className="flex items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-primary">
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-[13px] text-foreground">{section.title}</h3>
                <p className="truncate text-xs text-muted-foreground">{section.teaches}</p>
              </div>
              <span className="shrink-0 self-start text-xs text-muted-foreground">
                {section.presets.length} {section.presets.length === 1 ? 'run' : 'runs'}
              </span>
            </div>

            {/* Thin rows in one surface, divided by hairlines; rows cascade in and each arrow
                leans forward under the pointer. */}
            <AnimatedGroup
              preset="blur-slide"
              className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-background"
            >
              {section.presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => onRun(preset)}
                  className="group flex w-full items-center gap-3 px-3 py-2 text-left text-foreground transition-colors duration-300 hover:bg-accent active:bg-accent/80"
                  data-testid={`explore-preset-${preset.id}`}
                >
                  <preset.icon className="h-4 w-4 shrink-0 text-muted-foreground transition-colors duration-300 group-hover:text-primary" />
                  <div className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[13px] text-foreground transition-transform duration-300 group-hover:translate-x-0.5">
                        {preset.title}
                      </span>
                      {preset.requires ? (
                        <Badge variant="outline" size="sm" className="shrink-0">
                          {REQUIREMENT_LABEL[preset.requires]}
                        </Badge>
                      ) : preset.readiness === 'robust' ? (
                        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="h-1 w-1 rounded-full bg-primary" />
                          Ready to run
                        </span>
                      ) : null}
                    </span>
                    <span
                      className="block truncate text-xs text-muted-foreground"
                      title={preset.blurb}
                    >
                      {preset.blurb}
                    </span>
                  </div>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 -translate-x-0.5 text-muted-foreground/60 transition-all duration-300 group-hover:translate-x-0 group-hover:text-primary" />
                </button>
              ))}
            </AnimatedGroup>
          </Card>
        )
      })}
    </div>
  )

  const requestLink = requestUrl ? (
    <a
      href={requestUrl}
      target="_blank"
      rel="noreferrer"
      className="mt-6 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-primary"
    >
      Not seeing what you need? Request a capability
      <ArrowRight className="h-3 w-3" />
    </a>
  ) : null

  return (
    <div className={`@container font-mono ${className}`}>
      {showIntro ? (
        <Section
          title="Explore what Off Grid AI can do"
          description="Pick one, add your details, then start the run."
        >
          {panels}
          {requestLink}
        </Section>
      ) : (
        <>
          {panels}
          {requestLink}
        </>
      )}
    </div>
  )
}
