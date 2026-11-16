import {
  ChatCircleIcon,
  CubeIcon,
  DeviceMobileIcon,
  FilmSlateIcon,
  FolderSimpleIcon,
  ImageSquareIcon,
  KeyIcon,
  PlugsConnectedIcon,
  PuzzlePieceIcon,
  SpeakerHighIcon
} from '@phosphor-icons/react'
import type { ComponentType } from 'react'
import { FEATURE_GROUPS, PRO_FEATURES, featureSupportsPlatform } from '../pro/proCatalog'
import type { DevicePlatform } from '@offgrid/core/shared/device'
import { OFF_GRID_EXTENSION_URL, OFF_GRID_MOBILE_URL } from '@renderer/constants/links'
import type { ViewMode } from '@renderer/lib/view-modes'
import { GUIDE_MEDIA, type GuideMedia } from './guideMedia'

/**
 * Everything the "What it does for you" page shows and its Ask box knows: the Pro features
 * (their copy lives in proCatalog), the free core, and the rest of Off Grid AI beyond this
 * computer (the phone app and the browser extension). One list feeds the page and the prompt,
 * so the answer can never name a feature the page cannot show.
 */
export interface GuideTopic {
  id: string
  label: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: ComponentType<any>
  tagline: string
  description: string
  highlights: string[]
  group: string
  where: 'This computer' | 'Phone' | 'Browser'
  pro: boolean
  /** The screen in this app that opens it. */
  route?: ViewMode
  /** The page to get it, for things that live outside this app. */
  url?: string
  media?: GuideMedia
}

export const GUIDE_GROUPS = [
  ...FEATURE_GROUPS,
  { id: 'beyond', title: 'On your phone and browser' }
] as const

const FREE_TOPICS: Omit<GuideTopic, 'media'>[] = [
  {
    id: 'chat',
    label: 'Chat',
    icon: ChatCircleIcon,
    tagline: 'A private AI that runs on this computer.',
    description:
      'Chat with open models like Qwen, Llama, Gemma and Phi. They download once and run here, so your questions never go to an AI company. Works offline.',
    highlights: [
      'Attach files, images and screenshots',
      'Search the web when you allow it',
      'Copy or retry any answer'
    ],
    group: 'work',
    where: 'This computer',
    pro: false,
    route: 'memory-chat'
  },
  {
    id: 'images',
    label: 'Images',
    icon: ImageSquareIcon,
    tagline: 'Make pictures from a sentence.',
    description:
      'Ask for an image in chat and it is drawn on this computer with Stable Diffusion. No cloud GPU and no upload.',
    highlights: ['Styles to pick from', 'Runs on your own graphics chip', 'Free'],
    group: 'create',
    where: 'This computer',
    pro: false,
    route: 'memory-chat'
  },
  {
    id: 'models',
    label: 'Models',
    icon: CubeIcon,
    tagline: 'Pick the AI that fits your computer.',
    description:
      'Download chat, vision, voice and image models in one click. Off Grid AI picks the size that fits your memory, or you can connect your own Ollama or LM Studio server.',
    highlights: [
      'Sized for your computer',
      'Vision models read images',
      'Remote servers over your network'
    ],
    group: 'private',
    where: 'This computer',
    pro: false,
    route: 'models'
  },
  {
    id: 'projects',
    label: 'Projects',
    icon: FolderSimpleIcon,
    tagline: 'Chat with your own documents.',
    description:
      'Put files in a project and ask about them. The documents are indexed on this computer and answers point back to the page they came from.',
    highlights: ['PDFs, docs and notes', 'Answers cite their source', 'Stays on this computer'],
    group: 'work',
    where: 'This computer',
    pro: false,
    route: 'projects'
  },
  {
    id: 'connectors',
    label: 'Connectors',
    icon: PlugsConnectedIcon,
    tagline: 'Bring your tools into chat.',
    description:
      'Connect tools and MCP servers so the assistant can read and act in the apps you already use, with your approval.',
    highlights: ['MCP servers', 'You approve each action', 'Free'],
    group: 'work',
    where: 'This computer',
    pro: false,
    route: 'connectors'
  },
  {
    id: 'phone',
    label: 'Off Grid AI on your phone',
    icon: DeviceMobileIcon,
    tagline: 'The same private AI on iPhone and Android.',
    description:
      'Chat, images, vision and documents run on the phone itself, even in airplane mode. With Pro the phone gets memory, hands-free voice, Notes, Vault and Video Studio, and pairs with this computer.',
    highlights: [
      'Free on the App Store and Google Play',
      'iPhone 12 or Android with 4 GB RAM and up',
      'Pair with this computer to share chats, notes and your Vault',
      'Improve any text from the Share menu (Pro)'
    ],
    group: 'beyond',
    where: 'Phone',
    pro: false,
    url: OFF_GRID_MOBILE_URL
  },
  {
    id: 'phone-voice',
    label: 'Voice mode on the phone',
    icon: SpeakerHighIcon,
    tagline: 'Talk hands-free. It answers out loud.',
    description:
      'Tap once and talk. The phone transcribes you, answers, and reads the answer back in the voice you pick. All of it on the phone.',
    highlights: ['Pick a voice', 'Works offline', 'Part of Pro'],
    group: 'beyond',
    where: 'Phone',
    pro: true,
    url: OFF_GRID_MOBILE_URL
  },
  {
    id: 'phone-video',
    label: 'Video Studio on the phone',
    icon: FilmSlateIcon,
    tagline: 'One sentence becomes a short clip.',
    description:
      'Type a line or pick a photo and the phone makes a short film. It can also send the work to this computer when the phone is slower.',
    highlights: [
      'Made on your phone or your computer',
      'Every film carries an AI label',
      'Part of Pro'
    ],
    group: 'beyond',
    where: 'Phone',
    pro: true,
    url: OFF_GRID_MOBILE_URL
  },
  {
    id: 'extension',
    label: 'Browser extension',
    icon: PuzzlePieceIcon,
    tagline: 'Tasks in your own signed-in browser.',
    description:
      'Add Off Grid AI to Chrome or Firefox. It uses the models on this computer, so pages stay here. Watch it plan and click; pause, stop or take over at any time.',
    highlights: [
      'Chat and connectors are free',
      'Tasks and your desktop tools need Pro',
      'Codes, card numbers and CAPTCHAs are refused'
    ],
    group: 'beyond',
    where: 'Browser',
    pro: false,
    url: OFF_GRID_EXTENSION_URL
  },
  {
    id: 'extension-vault',
    label: 'Vault in the browser',
    icon: KeyIcon,
    tagline: 'Your logins, in the sign-in field.',
    description:
      'Saved logins fill from your encrypted Vault on this computer. Nothing goes to a password company.',
    highlights: ['Fills on the right site only', 'Encrypted on this computer', 'Part of Pro'],
    group: 'beyond',
    where: 'Browser',
    pro: true,
    url: OFF_GRID_EXTENSION_URL
  }
]

/** Every topic this computer can show, in page order within each group. */
export function guideTopics(platform: DevicePlatform): GuideTopic[] {
  const pro: GuideTopic[] = PRO_FEATURES.filter((f) => featureSupportsPlatform(f, platform)).map(
    (f) => ({
      id: f.route,
      label: f.label,
      icon: f.icon,
      tagline: f.tagline,
      description: f.description,
      highlights: f.highlights,
      group: f.group,
      where: 'This computer',
      pro: true,
      route: f.route as ViewMode
    })
  )
  return [...FREE_TOPICS, ...pro].map((t) => ({ ...t, media: GUIDE_MEDIA[t.id] }))
}

const SHOW = /\[\[show:([a-z-]+)\]\]/g

/** The grounding the local model answers from: every topic, nothing else. */
export function guideSystemPrompt(topics: GuideTopic[]): string {
  const facts = topics
    .map(
      (t) =>
        `- id: ${t.id} | ${t.label} | ${t.where} | ${t.pro ? 'Pro' : 'Free'}\n  ${t.tagline} ${t.description}\n  ${t.highlights.join('; ')}`
    )
    .join('\n')
  return [
    'You are the guide inside Off Grid AI, a private AI app that runs on the computer and phone people already own.',
    'Answer questions about what Off Grid AI can do: this desktop app, the phone app and the browser extension.',
    'Use only the facts below. If the answer is not in them, say you do not know and suggest the website getoffgridai.co.',
    'Write short, plain sentences or bullets. Explain how to do the thing step by step when asked.',
    'After each feature you talk about, add a line with exactly [[show:<id>]] using its id from the list, so the app shows its picture. Show at most three.',
    'Pro costs $119 once or $7.99 a month and covers up to 5 devices.',
    '',
    'Facts:',
    facts
  ].join('\n')
}

export type AnswerPart = { kind: 'text'; text: string } | { kind: 'topic'; topic: GuideTopic }

/**
 * Splits an answer into text and the topics it asked to show. A model that forgets the
 * markers still gets pictures: the topics it names, at most three.
 */
export function answerParts(answer: string, topics: GuideTopic[]): AnswerPart[] {
  const byId = new Map(topics.map((t) => [t.id, t]))
  const parts: AnswerPart[] = []
  const shown = new Set<string>()
  let cursor = 0
  for (const match of answer.matchAll(SHOW)) {
    const text = answer.slice(cursor, match.index).trim()
    if (text) parts.push({ kind: 'text', text })
    cursor = match.index + match[0].length
    const topic = byId.get(match[1]!)
    if (topic && !shown.has(topic.id) && shown.size < 3) {
      shown.add(topic.id)
      parts.push({ kind: 'topic', topic })
    }
  }
  const rest = answer.slice(cursor).trim()
  if (rest) parts.push({ kind: 'text', text: rest })
  if (shown.size > 0) return parts
  const lower = answer.toLowerCase()
  const named = topics
    .filter((t) => lower.includes(t.label.toLowerCase()))
    .sort((a, b) => b.label.length - a.label.length)
    .slice(0, 3)
  return [...parts, ...named.map((topic) => ({ kind: 'topic' as const, topic }))]
}
