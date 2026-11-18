/**
 * Onboarding's first two questions: what you want to do (groups), then which ones (parts). The
 * lists, names and tiers come from @offgrid/features; this file only draws them for the desktop.
 */
import type { JSX } from 'react'
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
import { cn } from '@renderer/lib/utils'
import { BoostPromoLine } from '../BoostPromo'
import { LicenseActivation } from '../pro/UpgradeScreen'
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
  return <span className="font-mono text-[10px] tracking-widest text-neutral-500">PRO</span>
}

function StepHeading({
  eyebrow,
  title,
  line
}: Readonly<{ eyebrow: string; title: string; line: string }>): JSX.Element {
  return (
    <div className="max-w-xs">
      <p className="font-mono text-[11px] uppercase tracking-widest text-neutral-500">{eyebrow}</p>
      <h2 className="mt-3 text-4xl font-light tracking-tight text-white md:text-5xl">{title}</h2>
      <p className="mt-3 text-sm text-neutral-400">{line}</p>
    </div>
  )
}

/** Step 1: what do you want to do? Pick any group. */
export function GroupsStep({
  picks,
  onToggle
}: Readonly<{ picks: Picks; onToggle: (id: OnboardingGroupId) => void }>): JSX.Element {
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-10 lg:grid-cols-[280px_minmax(0,1fr)] lg:items-center">
      <div>
        <StepHeading
          eyebrow="Off Grid AI · Setup"
          title="What do you want to do?"
          line="Pick any. Next you choose the details."
        />
        <BoostPromoLine delay={0.6} className="mt-6 justify-start text-left" />
      </div>
      <div
        role="group"
        aria-label="What you want to do"
        className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4"
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
              className={cn(
                'relative flex min-h-32 flex-col justify-end gap-1 rounded-xl border p-4 text-left backdrop-blur transition-colors duration-100',
                on
                  ? 'border-emerald-400/70 bg-emerald-500/[0.07]'
                  : 'border-white/10 bg-white/[0.03] hover:border-white/20'
              )}
            >
              <Icon className="absolute left-4 top-4 h-6 w-6 text-neutral-300" />
              <span className="absolute right-4 top-4 flex items-center gap-2">
                {groupIsPro(g.id) ? <ProTag /> : null}
                {on ? <CheckCircleIcon weight="fill" className="h-4 w-4 text-emerald-400" /> : null}
              </span>
              <span className="text-[15px] text-white">{g.name}</span>
              <span className="text-xs text-neutral-400">{g.does}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Step 2: which ones? The parts of each picked group, in columns. */
export function FeaturesStep({
  picks,
  onToggle
}: Readonly<{ picks: Picks; onToggle: (id: string) => void }>): JSX.Element {
  const groups = onboardingGroups(PLATFORM).filter((g) => picks.groups.includes(g.id))
  const proPicked = picks.parts.some((id) => {
    const part = partsFor(picks.groups, PLATFORM).find((p) => p.id === id)
    return part ? isPro(part) : false
  })
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-10 lg:grid-cols-[240px_minmax(0,1fr)]">
      <div>
        <StepHeading
          eyebrow="The details"
          title="Which ones?"
          line="We only set up what you pick. Add more any time."
        />
        {proPicked ? (
          <div className="mt-8 grid gap-2" data-testid="onboarding-have-pro">
            <LicenseActivation />
            <p className="text-xs text-neutral-500">
              Or pair a device that has Pro, from DevicesIcon, once you are set up.
            </p>
          </div>
        ) : null}
      </div>
      <div className="grid content-start gap-6 md:grid-cols-2 xl:grid-cols-3">
        {groups.map((g) => (
          <section key={g.id} aria-labelledby={`onboarding-parts-${g.id}`}>
            <h3
              id={`onboarding-parts-${g.id}`}
              className="mb-2 font-mono text-[11px] uppercase tracking-widest text-neutral-500"
            >
              {g.name}
            </h3>
            <div className="grid gap-2">
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
                    className={cn(
                      'flex min-h-14 items-start gap-3 rounded-lg border px-3 py-2.5 text-left backdrop-blur transition-colors duration-100',
                      on
                        ? 'border-emerald-400/50 bg-emerald-500/[0.06]'
                        : 'border-white/10 bg-white/[0.03] hover:border-white/20'
                    )}
                  >
                    <Icon className="mt-0.5 h-5 w-5 shrink-0 text-neutral-300" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm text-white">
                        {p.name}
                        {isPro(p) ? <ProTag /> : null}
                      </span>
                      <span className="block text-xs text-neutral-400">{p.does}</span>
                      {p.platforms[PLATFORM] === 'large' ? (
                        <span className="block text-xs text-neutral-500">
                          Needs a large model. It runs best on a computer with lots of memory.
                        </span>
                      ) : null}
                    </span>
                    {on ? (
                      <CheckCircleIcon
                        weight="fill"
                        className="h-5 w-5 shrink-0 text-emerald-400"
                      />
                    ) : (
                      <CircleIcon className="h-5 w-5 shrink-0 text-neutral-600" />
                    )}
                  </button>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
