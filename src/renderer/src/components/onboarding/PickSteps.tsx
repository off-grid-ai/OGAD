/**
 * Onboarding's first two questions: what you want to do (groups), then which ones (parts). The
 * lists, names and tiers come from @offgrid/features; this file only draws them for the desktop.
 */
import type { JSX } from 'react'
import { t } from '@offgrid/i18n'
import {
  onboardingGroups,
  partsFor,
  tierOf,
  type FeaturePart,
  type OnboardingGroupId
} from '@offgrid/features'
import {
  BrainIcon,
  BrowserIcon,
  CalendarBlankIcon,
  ChatCircleIcon,
  CheckCircleIcon,
  CheckSquareIcon,
  CircleIcon,
  ClipboardTextIcon,
  DevicesIcon,
  FileTextIcon,
  FilmSlateIcon,
  GlobeIcon,
  HardDrivesIcon,
  ImageIcon,
  ListChecksIcon,
  MicrophoneIcon,
  NotePencilIcon,
  PencilSimpleIcon,
  PlugsIcon,
  RewindIcon,
  ShieldCheckIcon,
  SpeakerHighIcon,
  SparkleIcon,
  UsersIcon,
  UsersThreeIcon,
  WaveformIcon,
  type Icon
} from '@phosphor-icons/react'
import { PageHeader } from '@offgrid/operator-ui/operator/experience'
import { cn } from '@renderer/lib/utils'
import { BoostPromoLine } from '../BoostPromo'
import { LicenseActivation } from '../pro/UpgradeScreen'
import { useRendererEntitlement } from '@renderer/bootstrap/useRendererEntitlement'
import type { Picks } from './picks'

const PLATFORM = 'desktop' as const

const GROUP_ICONS: Record<OnboardingGroupId, Icon> = {
  chat: ChatCircleIcon,
  create: ImageIcon,
  write: PencilSimpleIcon,
  remember: RewindIcon,
  meetings: UsersThreeIcon,
  work: ListChecksIcon,
  private: ShieldCheckIcon
}

const PART_ICONS: Record<string, Icon> = {
  chat: ChatCircleIcon,
  'own-server': HardDrivesIcon,
  'ask-photo': ImageIcon,
  images: SparkleIcon,
  'video-studio': FilmSlateIcon,
  'voice-mode': SpeakerHighIcon,
  dictation: WaveformIcon,
  scribe: PencilSimpleIcon,
  notes: NotePencilIcon,
  'ask-documents': FileTextIcon,
  vault: ShieldCheckIcon,
  replay: RewindIcon,
  day: CalendarBlankIcon,
  clipboard: ClipboardTextIcon,
  meetings: MicrophoneIcon,
  people: UsersIcon,
  todos: CheckSquareIcon,
  assistant: BrainIcon,
  'computer-use': BrowserIcon,
  'web-search': GlobeIcon,
  integrations: PlugsIcon,
  sync: DevicesIcon
}

const partIcon = (id: string): Icon => PART_ICONS[id] ?? CircleIcon

const isPro = (part: FeaturePart): boolean => tierOf(part, PLATFORM) === 'pro'

/** A group reads as Pro when everything in it on this app is Pro. */
function groupIsPro(id: OnboardingGroupId): boolean {
  const parts = partsFor([id], PLATFORM)
  return parts.length > 0 && parts.every(isPro)
}

function ProTag(): JSX.Element {
  return (
    <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
      Pro
    </span>
  )
}

/** A choice: a glass tile that shows it is picked within one frame, with a small press. */
const choice = (on: boolean): string =>
  cn(
    'rounded-xl border text-left transition-[transform,border-color,background-color] duration-150 active:scale-[0.98]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
    on
      ? 'border-primary/60 bg-primary/[0.06]'
      : 'border-border bg-card/60 hover:border-foreground/20'
  )

function Tick({ on, size }: Readonly<{ on: boolean; size: string }>): JSX.Element {
  return on ? (
    <CheckCircleIcon
      weight="fill"
      aria-hidden="true"
      className={cn(size, 'shrink-0 text-primary')}
    />
  ) : (
    <CircleIcon aria-hidden="true" className={cn(size, 'shrink-0 text-muted-foreground/50')} />
  )
}

/** Step 1: what do you want to do? Pick any group. */
export function GroupsStep({
  picks,
  onToggle
}: Readonly<{ picks: Picks; onToggle: (id: OnboardingGroupId) => void }>): JSX.Element {
  return (
    <div className="my-auto grid w-full gap-8">
      <PageHeader
        eyebrow={t('Off Grid AI · Setup')}
        title="What do you want to do?"
        description={t('Pick any. Next you choose the details.')}
      />
      <div
        role="group"
        aria-label="What you want to do"
        className="grid grid-cols-2 gap-3 lg:grid-cols-4"
      >
        {onboardingGroups(PLATFORM).map((g) => {
          const Icon = GROUP_ICONS[g.id]
          const on = picks.groups.includes(g.id)
          return (
            <button
              key={g.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              data-testid={`onboarding-group-${g.id}`}
              onClick={() => onToggle(g.id)}
              className={cn(choice(on), 'flex min-h-44 flex-col gap-1 p-5')}
            >
              <span className="mb-auto flex items-center justify-between pb-4">
                <Icon aria-hidden="true" className="h-5 w-5 text-foreground" />
                <span className="flex items-center gap-2">
                  {groupIsPro(g.id) ? <ProTag /> : null}
                  <Tick on={on} size="h-4 w-4" />
                </span>
              </span>
              <span className="text-sm text-foreground">{g.name}</span>
              <span className="text-xs text-muted-foreground">{g.does}</span>
            </button>
          )
        })}
      </div>
      <BoostPromoLine delay={0.6} className="justify-start text-left" />
    </div>
  )
}

/** Step 2: which ones? The parts of each picked group, a column per group. */
export function FeaturesStep({
  picks,
  onToggle
}: Readonly<{ picks: Picks; onToggle: (id: string) => void }>): JSX.Element {
  const groups = onboardingGroups(PLATFORM).filter((g) => picks.groups.includes(g.id))
  const offered = partsFor(picks.groups, PLATFORM)
  // With Pro already active the picks just work, so the licence entry is only for people without it.
  const { isPro: hasPro } = useRendererEntitlement()
  const proPicked = !hasPro && offered.some((p) => picks.parts.includes(p.id) && isPro(p))
  return (
    <div className="my-auto grid w-full gap-8">
      <PageHeader
        eyebrow={t('The details')}
        title="Which ones?"
        description={t('We only set up what you pick. Add more any time.')}
      />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] items-start gap-x-4 gap-y-6">
        {groups.map((g) => (
          <section key={g.id} aria-labelledby={`onboarding-parts-${g.id}`} className="grid gap-2">
            <h3
              id={`onboarding-parts-${g.id}`}
              className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
            >
              {g.name}
            </h3>
            {partsFor([g.id], PLATFORM).map((p) => {
              const Icon = partIcon(p.id)
              const on = picks.parts.includes(p.id)
              return (
                <button
                  key={p.id}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  data-testid={`onboarding-part-${p.id}`}
                  onClick={() => onToggle(p.id)}
                  className={cn(choice(on), 'flex min-h-14 items-start gap-3 px-3 py-2.5')}
                >
                  <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm text-foreground">
                      {p.name}
                      {isPro(p) ? <ProTag /> : null}
                    </span>
                    <span className="block text-xs text-muted-foreground">{p.does}</span>
                    {p.platforms[PLATFORM] === 'large' ? (
                      <span className="block text-xs text-muted-foreground">
                        Needs a large model. It runs best with lots of memory.
                      </span>
                    ) : null}
                  </span>
                  <Tick on={on} size="h-4 w-4" />
                </button>
              )
            })}
          </section>
        ))}
      </div>
      {proPicked ? (
        <div
          className="grid max-w-md gap-2 border-t border-border pt-6"
          data-testid="onboarding-have-pro"
        >
          <LicenseActivation />
          <p className="text-xs text-muted-foreground">
            Or pair a device that has Pro, from Devices, once you are set up.
          </p>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Settings → What you use: every group with its features, picked ones ticked. A change saves at
 * once and the menu and model setup follow it.
 */
export function WhatYouUse({
  picks,
  onToggle
}: Readonly<{ picks: Picks; onToggle: (id: string) => void }>): JSX.Element {
  return (
    <div className="grid gap-5">
      <p className="text-xs text-muted-foreground">
        What you pick leads your menu and is checked in model setup. Everything else stays one click
        away.
      </p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] items-start gap-x-4 gap-y-5">
        {onboardingGroups(PLATFORM).map((g) => (
          <section key={g.id} aria-labelledby={`what-you-use-${g.id}`} className="grid gap-2">
            <h3
              id={`what-you-use-${g.id}`}
              className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
            >
              {g.name}
            </h3>
            {partsFor([g.id], PLATFORM).map((p) => {
              const Icon = partIcon(p.id)
              const on = picks.parts.includes(p.id)
              return (
                <button
                  key={p.id}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  data-testid={`what-you-use-${p.id}`}
                  onClick={() => onToggle(p.id)}
                  className={cn(choice(on), 'flex items-center gap-3 px-3 py-2')}
                >
                  <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-foreground" />
                  <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-foreground">
                    <span className="truncate">{p.name}</span>
                    {isPro(p) ? <ProTag /> : null}
                  </span>
                  <Tick on={on} size="h-4 w-4" />
                </button>
              )
            })}
          </section>
        ))}
      </div>
    </div>
  )
}
