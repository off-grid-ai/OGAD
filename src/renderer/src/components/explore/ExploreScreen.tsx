import { ExploreSection } from './ExploreSection'
import { ALL_PRESETS, PRESET_SECTIONS, REQUEST_FORM_URL, type DemoPreset } from './presetCatalog'

/**
 * The Explore landing view: the demo-preset catalog as a first-class screen, so the presets are
 * discoverable to everyone (free + pro) without having to open a fresh chat to find them.
 *
 * Tapping a preset hands `preset` back to the host, which opens a fresh chat with the catalog-owned
 * intake form (see App's handleRunPreset -> MemoryChat openTarget.presetId). The section itself is
 * reused verbatim from the chat empty state - one component, two placements; this screen adds the
 * page header and hides the section's compact intro.
 */
export function ExploreScreen({
  onRunPreset
}: {
  onRunPreset: (preset: DemoPreset) => void
}): React.ReactElement {
  return (
    <div className="w-full font-mono">
      <div className="mb-5 flex items-end justify-between gap-4 border-b border-neutral-900 pb-4">
        <div>
          <h1 className="text-lg tracking-tight text-white">Explore</h1>
          <p className="mt-1 text-xs text-neutral-500">
            Pick a run - add the details once, then start it in chat. Everything happens on your
            Mac.
          </p>
        </div>
        <span className="shrink-0 pb-0.5 text-[10px] uppercase tracking-wide text-neutral-600">
          {ALL_PRESETS.length} runs / {PRESET_SECTIONS.length} capabilities
        </span>
      </div>
      <ExploreSection showIntro={false} onRun={onRunPreset} requestUrl={REQUEST_FORM_URL} />
    </div>
  )
}
