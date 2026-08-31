import { useState } from 'react'
import { ChatCircleDots, PaperPlaneTilt } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { openExternal } from '@/constants/links'
import { ExploreSection } from './ExploreSection'
import { ALL_PRESETS, PRESET_SECTIONS, type DemoPreset } from './presetCatalog'

const SUPPORT_EMAIL = 'support@getoffgridai.co'

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
  const [flowRequest, setFlowRequest] = useState('')
  const sendRequest = (): void => {
    const body = flowRequest.trim()
    if (!body) return
    openExternal(
      `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Explore flow request')}&body=${encodeURIComponent(`Here is the flow I would like to see in Off Grid AI:\n\n${body}`)}`
    )
  }
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
      <ExploreSection showIntro={false} onRun={onRunPreset} />
      <section className="mt-5 grid gap-4 rounded-md border border-primary/35 bg-card p-5 text-card-foreground @3xl:grid-cols-[minmax(0,0.7fr)_minmax(20rem,1.3fr)]">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-primary/30 bg-primary/5 text-primary">
            <ChatCircleDots className="h-5 w-5" />
          </span>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-primary">Shape Explore</p>
            <h2 className="mt-1 text-sm text-foreground">What should Off Grid AI do next?</h2>
            <p className="mt-1.5 max-w-md text-[11px] leading-5 text-muted-foreground">
              Tell us about a real workflow you want to run. Your requests decide which flows we
              build next.
            </p>
            <p className="mt-2 text-[10px] text-muted-foreground">{SUPPORT_EMAIL}</p>
          </div>
        </div>
        <div>
          <label
            htmlFor="explore-flow-request"
            className="text-[10px] uppercase tracking-wide text-muted-foreground"
          >
            Describe the flow you want
          </label>
          <textarea
            id="explore-flow-request"
            value={flowRequest}
            onChange={(event) => setFlowRequest(event.target.value)}
            placeholder="Example: Review my open support threads, draft replies in my voice, and stop before anything is sent."
            rows={4}
            className="mt-1 min-h-24 w-full resize-y rounded-md border border-border bg-background px-3 py-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
          />
          <div className="mt-3 flex justify-end">
            <Button size="sm" disabled={!flowRequest.trim()} onClick={sendRequest}>
              <PaperPlaneTilt /> Write to us
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}
