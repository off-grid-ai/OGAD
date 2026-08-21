// The Explore catalog: a small, curated set of starter prompts grouped by the capability
// each one shows off. Tapping a preset opens a real chat seeded with `prompt` - the agent
// then asks its own follow-ups and acts, so the preset both demos a capability and teaches
// that prompting is a conversation, not a one-shot.
//
// This is the single source of truth for the home "Explore" card, the empty-chat chips, and
// the preset picker. It is data only - no pro logic lives here; a preset that needs a pro
// capability (or a paired phone, or capture history) is tagged via `requires` so the surface
// can gate or annotate it.

/** The capability a section demonstrates. Drives grouping + the icon/label per section. */
export type PresetCapability = 'browser' | 'computer-use' | 'memory' | 'phone'

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
  /** Card title, e.g. "Find me a flight to book". */
  title: string
  /** The starter prompt seeded into the chat. The user never has to write it. */
  prompt: string
  /** One line: what this run shows the user. */
  blurb: string
  readiness: DemoReadiness
  /** Absent = available in any build. Present = gate/annotate before offering a live run. */
  requires?: PresetRequirement
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
        title: 'Find me a flight to book',
        prompt: 'Find me a flight to book and show me the best options.',
        blurb: 'Asks where, when, and your priority - then searches and lists the options.',
        readiness: 'needs-setup'
      },
      {
        id: 'best-nearby',
        title: 'Find the best-reviewed spots nearby',
        prompt: 'Find the three best-reviewed places near me for a specific kind of food, open right now.',
        blurb: 'Reads maps + reviews and comes back with a short, ranked pick.',
        readiness: 'robust'
      },
      {
        id: 'price-compare',
        title: 'Compare a price across stores',
        prompt: 'Compare the price of a product I name across a few stores and tell me where it is cheapest.',
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
        title: 'Play something and set the volume',
        prompt: 'Play something upbeat and set the volume to about 30%.',
        blurb: 'Opens Music and adjusts the volume - a clean, common desktop action.',
        readiness: 'robust'
      },
      {
        id: 'crop-screenshot',
        title: 'Edit my latest screenshot',
        prompt: 'Open my most recent screenshot and crop it to the top half.',
        blurb: 'Finds the file, opens it, and makes an edit in a bundled app.',
        readiness: 'robust'
      },
      {
        id: 'draft-reply',
        title: 'Draft an email reply',
        prompt: 'Draft a reply to the last email from a person I name, saying I will get back to them Monday.',
        blurb: 'Reads the thread and writes a reply for you to send.',
        readiness: 'needs-setup'
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
        title: 'What did I work on today?',
        prompt: 'What did I work on this morning?',
        blurb: 'Recalls your on-device activity into a short summary.',
        readiness: 'needs-data',
        requires: 'capture-history'
      },
      {
        id: 'that-article',
        title: 'Find that thing I saw earlier',
        prompt: 'What was that article I had open earlier about a topic I name?',
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
        title: "From your phone, ask your Mac to summarize today",
        prompt: 'Summarize what I looked at on my Mac today.',
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
