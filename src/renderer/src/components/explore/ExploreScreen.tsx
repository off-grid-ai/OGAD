import { ExploreSection } from './ExploreSection'
import { REQUEST_FORM_URL, type DemoPreset } from './presetCatalog'

/**
 * The Explore landing view: the demo-preset catalog as a first-class screen, so the presets are
 * discoverable to everyone (free + pro) without having to open a fresh chat to find them.
 *
 * Tapping a preset hands `preset` back to the host, which opens a fresh chat seeded with the
 * prompt (see App's handleRunPreset -> MemoryChat openTarget.seedPrompt). The section itself is
 * reused verbatim from the chat empty state - one component, two placements.
 */
export function ExploreScreen({
  onRunPreset
}: {
  onRunPreset: (preset: DemoPreset) => void
}): React.ReactElement {
  return (
    <div className="mx-auto max-w-5xl">
      <ExploreSection onRun={onRunPreset} requestUrl={REQUEST_FORM_URL} />
    </div>
  )
}
