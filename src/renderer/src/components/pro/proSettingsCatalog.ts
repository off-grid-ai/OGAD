// Static catalogue of the Pro SETTINGS sections — the settings-screen analogue of
// proCatalog.ts (which does the same for the sidebar nav). Core owns the slot list,
// the render order, and the free-build placeholder copy; the pro package registers
// the REAL section components against these ids via the section-registry seam
// (bootstrap/sectionRegistry). This keeps pro section LOGIC out of the public core
// repo — core carries only the inert placeholder shell and renders whichever slots
// pro has filled.
//
// Free build: each slot with placeholder copy renders a dimmed ProPlaceholder; a
// slot with `placeholder: null` (e.g. "Your Pro plan") renders nothing until pro
// registers it. Pro build: core renders the registered section component in the
// slot's position.

export interface ProSettingsSlot {
  /** Matches the id a registered SettingsSection claims when pro is active. */
  id: string
  /** Entrance-animation delay, kept in sync with the surrounding core cards. */
  delay: number
  /** Free-build teaser. null = render nothing when the slot isn't registered. */
  placeholder: { title: string; description: string } | null
  /** Runtime-backed section is withheld outside macOS until that implementation is tested. */
  macOnly?: boolean
  /** Copy shown to an entitled user when a Mac-only section is unavailable. */
  comingSoonDescription?: string
}

// Array order IS the render order in the Settings screen (between "Setup & health"
// and "Data & privacy").
export const PRO_SETTINGS_SLOTS: ProSettingsSlot[] = [
  {
    id: 'capture',
    delay: 0.14,
    macOnly: true,
    comingSoonDescription:
      'Screen capture controls are available on Mac today. Support for this device is coming soon.',
    placeholder: {
      title: 'Capture',
      description:
        'See whether screen capture is running, and pause, resume, or restart it - a control that works even if the menu-bar icon is unavailable.'
    }
  },
  {
    id: 'sync',
    delay: 0.16,
    placeholder: {
      title: 'Device sync',
      description:
        'Pair your Mac and your phone and they stay in step - the same chats, projects and model settings on both. A direct encrypted link over your own network; nothing is uploaded.'
    }
  },
  {
    id: 'identity',
    delay: 0.15,
    placeholder: {
      title: 'You',
      description:
        'Tell Off Grid who you are so it can attribute your messages, commitments, and calendar - part of the Pro intelligence layer.'
    }
  },
  {
    id: 'proactive',
    delay: 0.18,
    macOnly: true,
    comingSoonDescription:
      'Morning briefings and meeting alerts are available on Mac and phone today. Support for this device is coming soon.',
    placeholder: {
      title: 'Proactive delivery',
      description:
        'A morning briefing and a heads-up before each meeting - native notifications, even when the window is closed.'
    }
  },
  {
    id: 'secretary',
    delay: 0.22,
    macOnly: true,
    comingSoonDescription:
      'Learned preferences are available on Mac and phone today. Support for this device is coming soon.',
    placeholder: {
      title: 'What Off Grid has learned',
      description:
        'Preferences distilled from the suggestions you dismiss, fed back to your assistant so it gets sharper over time.'
    }
  },
  // "Your Pro plan" has no free teaser — only shown once pro registers it.
  { id: 'pro-plan', delay: 0.3, placeholder: null }
]
