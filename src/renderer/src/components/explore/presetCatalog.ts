// The Explore catalog: a small, curated set of starter prompts grouped by the capability
// each one shows off. Tapping a preset opens a real chat seeded with `prompt` - the agent
// then asks its own follow-ups and acts, so the preset both demos a capability and teaches
// that prompting is a conversation, not a one-shot.
//
// This is the single source of truth for the home "Explore" card, the empty-chat chips, and
// the preset picker. It is data only - no pro logic lives here; a preset that needs a pro
// capability (or a paired phone, or capture history) is tagged via `requires` so the surface
// can gate or annotate it.
//
// The one presentation field each preset carries is its Phosphor icon - defined here, once,
// so the Explore screen, the chat empty state, and any future picker all show the same mark.

import {
  AirplaneTilt,
  ClockCounterClockwise,
  Crop,
  EnvelopeSimple,
  MagnifyingGlass,
  MapPin,
  PaperPlaneTilt,
  Presentation,
  SpotifyLogo,
  Tag,
  type Icon
} from '@phosphor-icons/react'

/** The capability a section demonstrates. Drives grouping + the icon/label per section. */
export type PresetCapability = 'browser' | 'computer-use' | 'creation' | 'memory' | 'phone'

/**
 * How reliable a live run of this preset is, so the surface can lead with the safe ones:
 *  - robust:     runs cleanly on the local model + tools against non-flaky targets
 *  - needs-setup: depends on real app state (a real email thread, a specific app)
 *  - needs-data:  depends on capture history that a brand-new profile does not have yet
 */
export type DemoReadiness = 'robust' | 'needs-setup' | 'needs-data'

/** A gate the surface must honor before offering the preset as runnable. */
export type PresetRequirement = 'pro' | 'phone-paired' | 'capture-history'

export interface DemoPreset {
  id: string
  /**
   * Card label, e.g. "Find a flight". A short name for the capability, NEVER the raw
   * prompt - the surface shows the label + blurb only; the prompt stays behind the tap.
   */
  title: string
  /** The card's Phosphor icon. */
  icon: Icon
  /** The starter prompt seeded into the chat. The user never has to write it - or see it. */
  prompt: string
  /** One line: what this run shows the user. */
  blurb: string
  readiness: DemoReadiness
  /** Absent = available in any build. Present = gate/annotate before offering a live run. */
  requires?: PresetRequirement
  setup?: 'proposal-deck'
}

export interface PresetSection {
  id: string
  capability: PresetCapability
  /** Section heading, phrased as a capability the user gets. */
  title: string
  /** The lesson the section teaches, one line. */
  teaches: string
  presets: DemoPreset[]
}

export const PRESET_SECTIONS: readonly PresetSection[] = [
  {
    id: 'browser',
    capability: 'browser',
    title: 'Browse the web for you',
    teaches: 'Hand it a vague web errand and it asks for the specifics, then operates a browser.',
    presets: [
      {
        id: 'find-flight',
        icon: AirplaneTilt,
        title: 'Find a flight',
        prompt:
          'Go to skyscanner.com and help me find a flight to book. I will give you the route, dates, and budget when you ask.',
        blurb: 'Asks where, when, and your priority - then searches and lists the options.',
        readiness: 'needs-setup'
      },
      {
        id: 'best-nearby',
        icon: MapPin,
        title: 'Best-reviewed spots nearby',
        prompt:
          'Open Google Maps and find the three best-reviewed places near me that are open right now, for a kind of food I will name.',
        blurb: 'Reads maps + reviews and comes back with a short, ranked pick.',
        readiness: 'robust'
      },
      {
        id: 'price-compare',
        icon: Tag,
        title: 'Compare prices across stores',
        prompt:
          'On Google Shopping, compare the price of a product I will name across a few stores and tell me where it is cheapest.',
        blurb: 'Checks a few retailers read-only and reports the best price.',
        readiness: 'robust'
      }
    ]
  },
  {
    id: 'computer-use',
    capability: 'computer-use',
    title: 'Drive your Mac',
    teaches: 'It operates real apps for you, not just chat.',
    presets: [
      {
        id: 'play-music',
        icon: SpotifyLogo,
        title: 'Play music on Spotify',
        prompt: 'Open the Spotify app and play some jazz.',
        blurb: 'Drives the Spotify app to start playing - a real native action you approve first.',
        readiness: 'robust'
      },
      {
        id: 'crop-screenshot',
        icon: Crop,
        title: 'Edit a screenshot',
        prompt: 'Open my most recent screenshot in the Preview app and crop it to the top half.',
        blurb: 'Finds the file, opens it, and makes an edit in a bundled app.',
        readiness: 'robust'
      },
      {
        id: 'draft-reply',
        icon: EnvelopeSimple,
        title: 'Draft an email reply',
        prompt:
          'Open Mail, find the latest email from a person I will name, and draft a reply saying I will get back to them Monday.',
        blurb: 'Reads the thread and writes a reply for you to send.',
        readiness: 'needs-setup'
      }
    ]
  },
  {
    id: 'creation',
    capability: 'creation',
    title: 'Build client-ready work',
    teaches: 'Turn your local references into a reviewed deliverable, without sending them away.',
    presets: [
      {
        id: 'proposal-deck',
        icon: Presentation,
        title: 'Build a proposal deck',
        prompt:
          '/proposal-deck Start a new client proposal. Ask me only for the company, meeting context, sale mode, audience geography, and optional website before you begin.',
        blurb:
          'Builds the story, slide plan, proof, copy, and illustrations through approval gates.',
        readiness: 'needs-setup',
        setup: 'proposal-deck'
      }
    ]
  },
  {
    id: 'memory',
    capability: 'memory',
    title: "Remembers what you've seen",
    teaches: 'It saw and remembered - all on-device, nothing left your Mac.',
    presets: [
      {
        id: 'work-today',
        icon: ClockCounterClockwise,
        title: 'Recall your day',
        prompt:
          'Look through what you have captured on my Mac and tell me what I worked on this morning.',
        blurb: 'Recalls your on-device activity into a short summary.',
        readiness: 'needs-data',
        requires: 'capture-history'
      },
      {
        id: 'that-article',
        icon: MagnifyingGlass,
        title: 'Find something you saw',
        prompt:
          'Search what you captured on my screen and find that article I had open earlier about a topic I will name.',
        blurb: 'Searches what it captured on your screen to surface it again.',
        readiness: 'needs-data',
        requires: 'capture-history'
      }
    ]
  },
  {
    id: 'phone',
    capability: 'phone',
    title: "Your Mac's tools, from your phone",
    teaches: 'Run this Mac from your phone, over your own network.',
    presets: [
      {
        id: 'phone-summarize',
        icon: PaperPlaneTilt,
        title: "Get today's summary on your phone",
        prompt: 'Summarize what I looked at on my Mac today, using what you have captured.',
        blurb: 'The phone hands the task to your Mac and shows the result.',
        readiness: 'needs-setup',
        requires: 'phone-paired'
      }
    ]
  }
] as const

/** Flat list of every preset, for the empty-chat chips + search. */
export const ALL_PRESETS: readonly DemoPreset[] = PRESET_SECTIONS.flatMap(
  (section) => section.presets
)

/** The reliable-by-default set to lead with (no setup, no data, no pairing needed). */
export const HEADLINE_PRESETS: readonly DemoPreset[] = ALL_PRESETS.filter(
  (preset) => preset.readiness === 'robust'
)

/**
 * Where "Request a capability" points. Set this to the Google Form once it exists; until
 * then it stays undefined and the surface simply hides the link (no broken link ships).
 */
export const REQUEST_FORM_URL: string | undefined = undefined
