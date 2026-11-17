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
import {
  DESKTOP_BEYOND_GROUP,
  GUIDE_LINKS,
  guideAnswerParts,
  guideFlowAnswer,
  guideGrounding as sharedGuideGrounding,
  guideStarterAnswer as sharedGuideStarterAnswer,
  guideTopicsFor,
  type GuideAnswerPart,
  type GuideFlowPlatform,
  type GuideWhere
} from '@offgrid/models'
import { FEATURE_GROUPS, PRO_FEATURES, featureSupportsPlatform } from '../pro/proCatalog'
import type { DevicePlatform } from '@offgrid/core/shared/device'
import type { ViewMode } from '@renderer/lib/view-modes'
import { GUIDE_MEDIA, type GuideMedia } from './guideMedia'

/**
 * Everything the "What it does for you" page shows and its Ask box knows. The words for the free
 * core, the phone and the browser live in @offgrid/models (the phone's guide reads the same list);
 * the Pro features' words live in proCatalog. This file adds what is the desktop's own: icons,
 * pictures and the screen each topic opens.
 */
export interface GuideTopic {
  id: string
  label: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: ComponentType<any>
  tagline: string
  description: string
  highlights: string[]
  /** Words people use for it that its text may not (shared topics only). */
  keywords?: string[]
  group: string
  where: GuideWhere
  pro: boolean
  /** The screen in this app that opens it. */
  route?: ViewMode
  /** The page to get it, for things that live outside this app. */
  url?: string
  media?: GuideMedia
}

export const GUIDE_GROUPS = [...FEATURE_GROUPS, DESKTOP_BEYOND_GROUP] as const

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ICONS: Record<string, ComponentType<any>> = {
  chat: ChatCircleIcon,
  images: ImageSquareIcon,
  models: CubeIcon,
  projects: FolderSimpleIcon,
  connectors: PlugsConnectedIcon,
  phone: DeviceMobileIcon,
  'phone-voice': SpeakerHighIcon,
  'phone-video': FilmSlateIcon,
  extension: PuzzlePieceIcon,
  'extension-vault': KeyIcon
}

const ROUTES: Record<string, ViewMode> = {
  chat: 'memory-chat',
  images: 'memory-chat',
  models: 'models',
  projects: 'projects',
  connectors: 'connectors'
}

/** Every topic this computer can show, in page order within each group. */
export function guideTopics(platform: DevicePlatform): GuideTopic[] {
  const shared: GuideTopic[] = guideTopicsFor('desktop').map((t) => ({
    id: t.id,
    label: t.label,
    icon: ICONS[t.id] ?? PuzzlePieceIcon,
    tagline: t.tagline,
    description: t.description,
    highlights: t.highlights,
    keywords: t.keywords,
    group: t.group,
    where: t.where,
    pro: t.pro,
    route: ROUTES[t.id],
    url: t.get ? GUIDE_LINKS[t.get] : undefined
  }))
  const pro: GuideTopic[] = PRO_FEATURES.filter((f) => featureSupportsPlatform(f, platform)).map(
    (f) => ({
      id: f.route,
      label: f.label,
      icon: f.icon,
      tagline: f.tagline,
      description: f.description,
      highlights: f.highlights,
      group: f.group,
      where: 'computer',
      pro: true,
      route: f.route as ViewMode
    })
  )
  return [...shared, ...pro].map((t) => ({ ...t, media: GUIDE_MEDIA[t.id] }))
}

type Turn = { role: 'user' | 'assistant'; content: string }

/** This computer as the guide's flows name platforms; undefined shows every platform's flows. */
function flowPlatform(platform: DevicePlatform): GuideFlowPlatform | undefined {
  if (platform === 'darwin') return 'mac'
  if (platform === 'win32') return 'windows'
  if (platform === 'linux') return 'linux'
  return undefined
}

/** The grounding the local model answers from: only the topics this conversation is about, and the
 * checked flows closest to the question. */
export function guideGrounding(
  topics: GuideTopic[],
  history: Turn[],
  platform: DevicePlatform,
  vector?: number[]
): string {
  return sharedGuideGrounding('desktop', topics, history, { platform: flowPlatform(platform), vector })
}

/** A starter question's answer, built by code with no model. Null for anything else. */
export function guideStarterAnswer(question: string, topics: GuideTopic[]): string | null {
  return sharedGuideStarterAnswer('desktop', question, topics)
}

/**
 * A "how do I…" question's answer from the app's checked flows (its own labels, in order), or a
 * short list to pick from; found by meaning when the question came with its vector. Null when no
 * flow fits: the model answers those.
 */
export function guideStepsAnswer(
  question: string,
  topics: GuideTopic[],
  platform: DevicePlatform,
  vector?: number[]
): string | null {
  return guideFlowAnswer('desktop', question, topics, { platform: flowPlatform(platform), vector })
}

export type AnswerPart = GuideAnswerPart<GuideTopic>

/** Splits an answer into text and the topics it asked to show (see guideAnswerParts). */
export function answerParts(answer: string, topics: GuideTopic[]): AnswerPart[] {
  return guideAnswerParts(answer, topics)
}
