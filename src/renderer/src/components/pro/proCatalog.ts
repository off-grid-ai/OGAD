import {
  CalendarBlank,
  ChartLineUp,
  Rewind,
  Microphone,
  CheckSquare,
  Graph,
  MagnifyingGlass,
  Broadcast,
  ClipboardText,
  Waveform,
  ShieldCheck
} from '@phosphor-icons/react'
import type { ComponentType } from 'react'
import { deviceNoun, primaryModifier } from '@renderer/lib/device'
import { isMac, type DevicePlatform } from '@offgrid/core/shared/device'
import { PRO_PURCHASE_URL } from '@offgrid/core/shared/product-links'

// Static catalogue of the Pro features. This ships in the OPEN build so the free
// app can advertise everything Pro unlocks — the sidebar shows these as locked
// tabs and each opens an UpgradeScreen writeup with the payment CTA. When the
// pro/ submodule is present and activated, the real screens (registered via
// screenRegistry/navRegistry) take over these same routes.

/** Buy Pro — live now, $49/year or $69 once, one license across up to 5 devices. */
export const PRO_PAY_URL = PRO_PURCHASE_URL

export interface ProFeature {
  /** Route name — matches the route a registered pro screen claims when unlocked. */
  route: string
  label: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: ComponentType<any>
  /** One-line pitch shown under the title. */
  tagline: string
  /** Upsell paragraph. */
  description: string
  /** Concrete capabilities, shown as a checklist. */
  highlights: string[]
  /**
   * Platforms this feature is tested + supported on — the SINGLE SOURCE OF TRUTH
   * for per-feature availability. macOS (`'darwin'`) is the reference platform and
   * MUST be present on every feature (Pro was built Mac-first). As a feature is
   * ported and verified on Windows, add `'win32'` here — that one edit flips the
   * feature live everywhere (nav routing, the coming-soon gate, upsell copy), since
   * every surface reads this list through `featureSupportsPlatform`. Do not gate a
   * feature on the platform anywhere else; add the platform here instead.
   */
  platforms: DevicePlatform[]
}

export const PRO_FEATURES: ProFeature[] = [
  {
    route: 'day',
    label: 'Day',
    icon: CalendarBlank,
    tagline: 'Your day, planned for you.',
    description:
      'Off Grid reads your calendar and what you’ve been working on and lays out your day — what’s next, who you’re meeting, and what’s still open — so you start every morning oriented instead of scrambling.',
    highlights: [
      'A morning briefing built from your real activity',
      'Per-meeting prep: who’s in it and your open items',
      'Priorities surfaced from what you actually did'
    ],
    // Ported to Windows: the whole Day path is portable - day.ts, day-layout.ts,
    // ahead.ts and calendar.ts carry no platform-native code. Its two data sources
    // both work on Windows now: the calendar comes from connectors (HTTP), and the
    // activity half reads observations, which Replay's port put on Windows. Landing
    // on Day now routes through `landingView` rather than an `isMac()` check, so nav,
    // gating, copy and the landing screen all agree.
    platforms: ['darwin', 'win32']
  },
  {
    route: 'reflect',
    label: 'Reflect',
    icon: ChartLineUp,
    tagline: 'See where your time really goes.',
    description:
      'A private, on-device breakdown of your focus — the apps, projects, and people that took your attention — so you can see your week clearly and adjust.',
    highlights: [
      'Daily & weekly mind-share',
      'Focus vs. distraction trends',
      'All computed locally — never uploaded'
    ],
    // Ported to Windows: Reflect adds no capture of its own — it is pure aggregation
    // over observations the capture pipeline already writes, which Replay's port put
    // on Windows. The whole path (crm/reflect.ts, its IPC, ReflectScreen) carries no
    // platform-native code and reaches SQLite through the same getDB core uses.
    platforms: ['darwin', 'win32']
  },
  {
    route: 'replay',
    label: 'Replay',
    icon: Rewind,
    tagline: 'Rewind anything you saw.',
    description:
      'Scrub back through your screen history to find that doc, message, or number you know you saw — captured on-device and searchable.',
    highlights: [
      'Timeline of captured frames',
      'Jump straight to the moment',
      'Stays on your machine'
    ],
    // Ported to Windows: the capture pipeline is vision-model-first, so the macOS OCR
    // binary is no longer on the path. Screenshots come from Electron desktopCapturer
    // and the frame store, replay reader and screen carry no platform-native code.
    // Accessibility text is macOS-only enrichment that never gates analysis, so on
    // Windows a vision model is what produces frame summaries.
    platforms: ['darwin', 'win32']
  },
  {
    route: 'meetings',
    label: 'Meetings',
    icon: Microphone,
    tagline: 'Record & transcribe meetings, locally.',
    description:
      'Capture Zoom, Meet, and Teams calls with system audio + mic and get a private transcript and summary — no cloud meeting bot, nothing leaves your device.',
    highlights: [
      'Auto-detects calls',
      'On-device transcription',
      'Searchable transcripts & summaries'
    ],
    platforms: ['darwin']
  },
  {
    route: 'actions',
    label: 'Actions',
    icon: CheckSquare,
    tagline: 'To-dos and actions, handled.',
    description:
      'Off Grid extracts the commitments out of your day and your secretary proposes the next step — every action waits in an approval queue, so nothing happens without your say-so.',
    highlights: [
      'Auto-extracted to-dos',
      'Secretary-proposed actions',
      'Approval-gated — you’re always in control'
    ],
    platforms: ['darwin']
  },
  {
    route: 'entities',
    label: 'Entities',
    icon: Graph,
    tagline: 'A private graph of your work.',
    description:
      'Every person, project, and company you touch becomes a record with a synthesized story across your screen activity, meetings, and connectors — your own CRM that builds itself.',
    highlights: [
      'Auto-built people & project records',
      'Cross-source narrative summaries',
      'Relationship graph'
    ],
    platforms: ['darwin']
  },
  {
    route: 'search',
    label: 'Search',
    icon: MagnifyingGlass,
    tagline: 'Search everything you’ve ever seen.',
    description:
      'One search bar across your captured activity, meetings, entities, and connectors — semantic + keyword, all on-device.',
    highlights: ['Unified semantic search', 'Across capture, meetings & connectors', 'Fully local'],
    platforms: ['darwin']
  },
  {
    route: 'notifications',
    label: 'Notifications',
    icon: Broadcast,
    tagline: 'Approvals & to-dos, surfaced.',
    description:
      'Off Grid reaches out first — a morning briefing, a heads-up before meetings, approvals waiting on your decision, and to-dos it pulled from your day — even when the window is closed.',
    highlights: [
      'Proactive briefings & meeting prep',
      'Approval queue for actions',
      'Auto-extracted to-dos'
    ],
    // Ported to Windows alongside Day, which produces its content: proactive.ts builds
    // notifications from getDayPlan / getEventPrep, so shipping this without Day would
    // have delivered an empty surface. Delivery is Electron's Notification (guarded by
    // isSupported()), and core already sets the AppUserModelID that Windows requires
    // for a toast to appear at all. notify.ts / proactive.ts carry no platform code.
    platforms: ['darwin', 'win32']
  },
  {
    route: 'voice',
    label: 'Voice',
    icon: Waveform,
    tagline: 'Talk instead of type, fully local.',
    description: `Hold Option+Space and speak — Off Grid AI Desktop transcribes on-device with whisper.cpp and pastes the text into whatever app you are in. Tap to toggle, hold to push-to-talk. Every recording and transcript is kept in a searchable library, and you can drop in any audio or video file to transcribe it. Runs in your ${deviceNoun()}'s RAM; nothing leaves the device.`,
    highlights: [
      'Option+Space push-to-talk or toggle, anywhere',
      'Paste-at-cursor + a searchable recordings library',
      'Transcribe any audio/video file, all on-device'
    ],
    platforms: ['darwin']
  },
  {
    route: 'vault',
    label: 'Vault',
    icon: ShieldCheck,
    tagline: 'Passwords and secrets, encrypted on this device.',
    description:
      'An encrypted KDBX4 vault for web logins, app passwords, API keys, secure notes, and secret files (.env and the like). Your master password and a device-specific key together lock the vault - the file alone is unreadable. Back up the file anywhere; it stays opaque without both factors. Sync to other devices in your Off Grid mesh via EasyShare when you are ready.',
    highlights: [
      'AES-256 + Argon2id, device-key bound',
      'Logins, app passwords, API keys, notes, and files',
      'KDBX4 format - compatible with KeePassXC'
    ],
    // First Pro feature ported to Windows: the vault engine is fully cross-platform
    // (KDBX4 via kdbxweb, Argon2id via hash-wasm WASM, BIP39 recovery, device key
    // via node-machine-id) - no macOS-native code. Verified on Windows.
    platforms: ['darwin', 'win32']
  },
  {
    route: 'clipboard',
    label: 'Clipboard',
    icon: ClipboardText,
    tagline: 'Every copy, kept and searchable.',
    description: `A local clipboard history that saves what you copy - text, images, and files - with a global hotkey (${primaryModifier()}+Shift+C) quick-paste popup to drop any past copy into whatever app you are in. Stored on-device, nothing leaves your machine.`,
    highlights: [
      'Searchable history of text, images & files',
      `${primaryModifier()}+Shift+C quick-paste popup anywhere`,
      'Stored locally in your encrypted database'
    ],
    // Ported to Windows: the store + popup + global hotkey (CommandOrControl+Shift+C)
    // are all cross-platform Electron; auto-paste is synthesized per-platform in
    // pro text-injection (osascript on macOS, PowerShell SendKeys on Windows).
    platforms: ['darwin', 'win32']
  }
]

export function getProFeature(route: string): ProFeature | undefined {
  return PRO_FEATURES.find((f) => f.route === route)
}

/**
 * Whether a single Pro feature is tested + supported on a platform. This is the
 * per-feature seam: read a feature's `platforms` list (its single source of truth)
 * rather than a blanket `!isMac` rule, so features go live on a new platform ONE AT
 * A TIME as each is ported and verified. Pure + unit-testable.
 *
 * macOS is the reference platform and is always supported, even if a `platforms`
 * list somehow omits it — so a data typo can never dark-out a feature on Mac (the
 * only platform where the whole Pro tier is known-good today).
 */
export function featureSupportsPlatform(feature: ProFeature, platform: DevicePlatform): boolean {
  return isMac(platform) || feature.platforms.includes(platform)
}

/**
 * The baseline rule for Pro surfaces that don't (yet) have their own per-feature
 * `platforms` declaration — today just the pro Settings sections (proactive
 * delivery, learned prefs), which aren't catalog routes. Pro runtime features are
 * macOS-tested only on those, so a Pro subscriber off macOS sees a "coming soon"
 * placeholder; free users are unaffected (they get the upsell). Catalog ROUTES use
 * the per-feature `featureSupportsPlatform` seam via `proFeatureComingSoon`
 * instead — prefer that for anything backed by a ProFeature.
 */
export function proComingSoonHere(platform: DevicePlatform, isPro: boolean): boolean {
  return isPro && !isMac(platform)
}

/**
 * Apply the platform rule only to registered Pro routes, never core or unknown
 * views — gated PER FEATURE on that feature's `platforms` list. Never fires for
 * free users (they get the upsell). Flip a feature live on a platform by adding it
 * to that feature's `platforms`.
 */
export function proFeatureComingSoon(
  route: string,
  platform: DevicePlatform,
  isPro: boolean
): boolean {
  if (!isPro) {
    return false
  }
  const feature = getProFeature(route)
  if (!feature) {
    return false
  }
  return !featureSupportsPlatform(feature, platform)
}

/**
 * Which view the app should OPEN on. Free users land on Models (they need a model
 * before anything else works); Pro users land on Day — but only where Day is
 * actually available.
 *
 * This lives here, beside the seam, because it is a per-feature platform decision and
 * `platforms` is the single source of truth for those. It previously sat in App.tsx as
 * `isPro && isMac() ? 'day' : 'models'`, which was right only by accident: it agreed
 * with the catalog while Day was macOS-only, and would have stranded a ported Day on
 * Windows — nav and gating would light Day up from `platforms` while the landing
 * screen still asked `isMac()`. Route the decision through the seam so porting a
 * feature never leaves a second place to update.
 *
 * Never land on a locked or unavailable tab.
 */
export function landingView(platform: DevicePlatform, isPro: boolean): 'day' | 'models' {
  const day = getProFeature('day')
  return isPro && day && featureSupportsPlatform(day, platform) ? 'day' : 'models'
}
