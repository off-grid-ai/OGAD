import {
  CalendarBlank,
  ChartLineUp,
  Rewind,
  Microphone,
  CheckSquare,
  Graph,
  Plug,
  MagnifyingGlass,
  Lightning,
  Broadcast,
} from '@phosphor-icons/react';
import type { ComponentType } from 'react';

// Static catalogue of the Pro features. This ships in the OPEN build so the free
// app can advertise everything Pro unlocks — the sidebar shows these as locked
// tabs and each opens an UpgradeScreen writeup with the payment CTA. When the
// pro/ submodule is present and activated, the real screens (registered via
// screenRegistry/navRegistry) take over these same routes.

/** Where the "Upgrade to Pro" buttons send the user. */
export const PRO_PAY_URL = 'https://offgridmobileai.co/pay';

export interface ProFeature {
  /** Route name — matches the route a registered pro screen claims when unlocked. */
  route: string;
  label: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: ComponentType<any>;
  /** One-line pitch shown under the title. */
  tagline: string;
  /** Upsell paragraph. */
  description: string;
  /** Concrete capabilities, shown as a checklist. */
  highlights: string[];
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
      'Priorities surfaced from what you actually did',
    ],
  },
  {
    route: 'reflect',
    label: 'Reflect',
    icon: ChartLineUp,
    tagline: 'See where your time really goes.',
    description:
      'A private, on-device breakdown of your focus — the apps, projects, and people that took your attention — so you can see your week clearly and adjust.',
    highlights: ['Daily & weekly mind-share', 'Focus vs. distraction trends', 'All computed locally — never uploaded'],
  },
  {
    route: 'replay',
    label: 'Replay',
    icon: Rewind,
    tagline: 'Rewind anything you saw.',
    description:
      'Scrub back through your screen history to find that doc, message, or number you know you saw — captured on-device and searchable.',
    highlights: ['Timeline of captured frames', 'Jump straight to the moment', 'Stays on your machine'],
  },
  {
    route: 'meetings',
    label: 'Meetings',
    icon: Microphone,
    tagline: 'Record & transcribe meetings, locally.',
    description:
      'Capture Zoom, Meet, and Teams calls with system audio + mic and get a private transcript and summary — no cloud meeting bot, nothing leaves your device.',
    highlights: ['Auto-detects calls', 'On-device transcription', 'Searchable transcripts & summaries'],
  },
  {
    route: 'actions',
    label: 'Actions',
    icon: CheckSquare,
    tagline: 'To-dos and actions, handled.',
    description:
      'Off Grid extracts the commitments out of your day and your secretary proposes the next step — every action waits in an approval queue, so nothing happens without your say-so.',
    highlights: ['Auto-extracted to-dos', 'Secretary-proposed actions', 'Approval-gated — you’re always in control'],
  },
  {
    route: 'entities',
    label: 'Entities',
    icon: Graph,
    tagline: 'A private graph of your work.',
    description:
      'Every person, project, and company you touch becomes a record with a synthesized story across your screen activity, meetings, and connectors — your own CRM that builds itself.',
    highlights: ['Auto-built people & project records', 'Cross-source narrative summaries', 'Relationship graph'],
  },
  {
    route: 'connectors',
    label: 'Integrations',
    icon: Plug,
    tagline: 'Bring Gmail, Slack, Notion & more into chat.',
    description:
      'Connect your tools via MCP and use them right inside chat. Reads happen instantly; anything that writes is routed to your approval queue first.',
    highlights: ['Gmail, Calendar, Slack, Notion, Jira & more', 'Use connectors directly in chat', 'Writes require approval'],
  },
  {
    route: 'search',
    label: 'Search',
    icon: MagnifyingGlass,
    tagline: 'Search everything you’ve ever seen.',
    description:
      'One search bar across your captured activity, meetings, entities, and connectors — semantic + keyword, all on-device.',
    highlights: ['Unified semantic search', 'Across capture, meetings & connectors', 'Fully local'],
  },
  {
    route: 'skills',
    label: 'Skills',
    icon: Lightning,
    tagline: 'Automations that run themselves.',
    description:
      'Turn a skill into an automation: trigger it on a schedule, a keyword you capture, or a new meeting/approval — and let it act (approval-gated) without you lifting a finger.',
    highlights: ['Schedule, keyword & event triggers', 'Runs through your connectors', 'Results delivered as notifications'],
  },
  {
    route: 'proactive',
    label: 'Proactive',
    icon: Broadcast,
    tagline: 'Off Grid reaches out first.',
    description:
      'Native nudges when they matter — a morning briefing and a heads-up before each meeting — even when the window is closed.',
    highlights: ['Morning briefing', 'Pre-meeting prep alerts', 'Silenceable any time'],
  },
];

export function getProFeature(route: string): ProFeature | undefined {
  return PRO_FEATURES.find((f) => f.route === route);
}
