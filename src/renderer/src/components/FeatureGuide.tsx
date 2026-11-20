import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { openImageChat } from '@/lib/chat-image-mode'
import {
  ArrowSquareOutIcon,
  CaretRightIcon,
  ChatCircleIcon,
  CheckIcon,
  LockSimpleIcon,
  NotePencilIcon,
  PaperPlaneRightIcon,
  SparkleIcon
} from '@phosphor-icons/react'
import { PageShell } from './PageShell'
import { Button } from './ui/button'
import { ChatMarkdown } from './ChatMarkdown'
import { currentPlatform } from '@renderer/lib/device'
import { openExternal } from '@renderer/constants/links'
import { productAction } from '@offgrid/features'
import { cn } from '@renderer/lib/utils'
import type { ViewMode } from '@renderer/lib/view-modes'
import {
  GUIDE_FIRST_LOOK,
  GUIDE_STARTERS,
  guideAnswerBlocks,
  guideAnswerLength,
  guideAnswerReveal,
  guideTypingMs,
  type GuideAnswerBlock,
  guideTurnsToSend,
  guideWhereLabel
} from '@offgrid/models'
import {
  GUIDE_GROUPS,
  answerParts,
  guideGrounding,
  guideFlowStepsById,
  guideStarterAnswer,
  guideStepsAnswer,
  guideTopics,
  type GuideTopic
} from './guide/guideKnowledge'
import type { GuideMedia } from './guide/guideMedia'

type Turn = { role: 'user' | 'assistant'; content: string }

const ASK = 'ask'

const STARTERS = GUIDE_STARTERS.desktop

/** A few features worth a first look, shown under the Ask box before anything is asked. */
const FIRST_LOOK = GUIDE_FIRST_LOOK.desktop

/** The app's theme is data-theme on <html>, so the light take shows only there. */
function MediaView({
  media,
  label,
  className
}: Readonly<{ media: GuideMedia; label: string; className?: string }>): React.ReactElement {
  if (media.kind === 'clip') {
    return (
      <video
        key={media.src}
        src={media.src}
        className={cn('block w-full', className)}
        autoPlay
        muted
        loop
        playsInline
        aria-label={label}
      />
    )
  }
  return (
    <>
      <img
        src={media.dark}
        alt={label}
        className={cn('block w-full object-contain [[data-theme=light]_&]:hidden', className)}
      />
      <img
        src={media.light}
        alt={label}
        className={cn('hidden w-full object-contain [[data-theme=light]_&]:block', className)}
      />
    </>
  )
}

/** The frame a picture sits in. Phone shots are tall, so they stand centred at a fixed height. */
function MediaFrame({
  topic,
  height,
  onClick
}: Readonly<{
  topic: GuideTopic
  height: string
  onClick?: () => void
}>): React.ReactElement | null {
  if (!topic.media) return null
  const tall = topic.media.kind === 'still' && topic.media.tall
  const body = (
    <MediaView
      media={topic.media}
      label={topic.label}
      className={tall ? `${height} w-auto max-w-full` : 'max-h-[56vh] w-auto max-w-full'}
    />
  )
  const frame = cn(
    'flex justify-center overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950',
    tall ? 'w-fit px-8 py-4' : 'w-full'
  )
  if (!onClick) return <div className={frame}>{body}</div>
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Show ${topic.label}`}
      className={cn(frame, 'transition-colors hover:border-green-500/60')}
    >
      {body}
    </button>
  )
}

function TopicTag({ topic }: Readonly<{ topic: GuideTopic }>): React.ReactElement {
  return (
    <span className="font-mono text-[10px] uppercase tracking-widest text-neutral-500">
      {guideWhereLabel('desktop', topic.where)} · {topic.pro ? 'Pro' : 'Free'}
    </span>
  )
}

function TopicAction({
  topic,
  isPro,
  onOpen,
  size = 'default',
  quiet = false
}: Readonly<{
  topic: GuideTopic
  isPro: boolean
  onOpen: (view: ViewMode) => void
  size?: 'default' | 'sm'
  /** Outline, when the screen's one primary action is elsewhere (onboarding's Set up). */
  quiet?: boolean
}>): React.ReactElement | null {
  if (topic.route) {
    const route = topic.route
    // Images opens chat in image mode; with no image model, Models on the Image tab instead.
    const open = (): void => {
      if (topic.id !== 'images') return onOpen(route)
      void openImageChat(() => onOpen(route))
    }
    return (
      <Button size={size} variant={quiet ? 'outline' : 'default'} onClick={open}>
        {topic.pro && !isPro ? <LockSimpleIcon className="h-4 w-4" /> : null}
        Open {topic.label}
      </Button>
    )
  }
  if (!topic.get) return null
  // It lives in another Off Grid AI app: the shared Get / Open <app> action. The extension's
  // store depends on this computer's default browser, which the main process works out.
  const action = productAction({ product: topic.get })
  const get = (): void => {
    if (topic.get === 'extension') void window.api.getExtension?.()
    else if (action.url) openExternal(action.url)
  }
  return (
    <span className="flex flex-wrap gap-2">
      <Button size={size} variant="outline" onClick={get}>
        {action.label}
        <ArrowSquareOutIcon className="h-4 w-4" />
      </Button>
      {topic.get === 'mobile' ? (
        // Already have the phone app: pairing it is in Sync, on this computer.
        <Button size={size} variant="ghost" onClick={() => onOpen('devices')}>
          {isPro ? null : <LockSimpleIcon className="h-4 w-4" />}
          Pair your phone
        </Button>
      ) : null}
    </span>
  )
}

function TopicDetail({
  topic,
  isPro,
  onOpen,
  onAsk,
  mediaHeight = 'h-[56vh]',
  footer,
  quiet = false
}: Readonly<{
  topic: GuideTopic
  isPro: boolean
  onOpen: (view: ViewMode) => void
  onAsk: (question: string) => void
  mediaHeight?: string
  /** Shown under the feature: onboarding puts Get Pro or the connections here. */
  footer?: ReactNode
  quiet?: boolean
}>): React.ReactElement {
  return (
    <article className="og-guide-in grid max-w-5xl gap-5" aria-labelledby="guide-topic-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <TopicTag topic={topic} />
          <h2 id="guide-topic-title" className="mt-1 text-2xl font-light text-neutral-100">
            {topic.label}
          </h2>
          <p className="mt-1 text-sm text-neutral-300">{topic.tagline}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => onAsk(`Tell me more about ${topic.label}.`)}
            data-testid="guide-topic-ask"
          >
            <ChatCircleIcon className="h-4 w-4" />
            Ask more
          </Button>
          <TopicAction topic={topic} isPro={isPro} onOpen={onOpen} quiet={quiet} />
        </div>
      </div>
      <MediaFrame topic={topic} height={mediaHeight} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <p className="text-sm leading-relaxed text-neutral-400">{topic.description}</p>
        <ul className="grid content-start gap-2">
          {topic.highlights.map((line) => (
            <li key={line} className="flex items-start gap-2 text-sm text-neutral-300">
              <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
              {line}
            </li>
          ))}
        </ul>
      </div>
      {footer}
    </article>
  )
}

/**
 * An answer types out once, when it arrives: text first, then its cards, in under a second
 * (the pace is shared with the phone's guide). With reduced motion it shows whole.
 */
function TypedAnswer({
  blocks,
  onGrow,
  children
}: {
  blocks: GuideAnswerBlock<GuideTopic>[]
  onGrow: () => void
  children: (blocks: GuideAnswerBlock<GuideTopic>[]) => ReactNode
}): React.JSX.Element {
  const total = guideAnswerLength(blocks)
  const [still] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [shown, setShown] = useState(still ? total : 0)
  const grow = useRef(onGrow)
  useEffect(() => {
    grow.current = onGrow
  }, [onGrow])
  useEffect(() => {
    if (still) return undefined
    const start = performance.now()
    const ms = guideTypingMs(total)
    let frame = 0
    const tick = (): void => {
      const t = Math.min(1, (performance.now() - start) / ms)
      setShown(Math.ceil(total * t))
      grow.current()
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [total, still])
  return <>{children(shown >= total ? blocks : guideAnswerReveal(blocks, shown))}</>
}

function AnswerCard({
  topic,
  isPro,
  onShow,
  onOpen
}: Readonly<{
  topic: GuideTopic
  isPro: boolean
  onShow: (id: string) => void
  onOpen: (view: ViewMode) => void
}>): React.ReactElement {
  return (
    <figure className="og-guide-in grid max-w-2xl gap-2">
      <MediaFrame topic={topic} height="h-72" onClick={() => onShow(topic.id)} />
      <figcaption className="flex items-center gap-2">
        <topic.icon className="h-4 w-4 shrink-0 text-neutral-400" />
        <button
          type="button"
          onClick={() => onShow(topic.id)}
          className="min-w-0 flex-1 truncate text-left text-sm text-neutral-100 hover:text-green-500"
        >
          {topic.label}
          <span className="text-neutral-500"> · {topic.tagline}</span>
        </button>
        <TopicAction topic={topic} isPro={isPro} onOpen={onOpen} size="sm" />
      </figcaption>
    </figure>
  )
}

/** One topic among several in an answer: icon, name and line, so a row of them lines up. It
 * opens the topic, where its action is. */
function AnswerTile({
  topic,
  onShow
}: Readonly<{ topic: GuideTopic; onShow: (id: string) => void }>): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => onShow(topic.id)}
      className="og-guide-in grid content-start gap-1 rounded-xl border border-neutral-800 p-3 text-left transition-colors hover:border-green-500/60"
    >
      <span className="flex items-center gap-2 text-sm text-neutral-100">
        <topic.icon className="h-4 w-4 shrink-0 text-green-500" />
        <span className="truncate">{topic.label}</span>
      </span>
      <span className="line-clamp-2 text-xs text-neutral-500">{topic.tagline}</span>
    </button>
  )
}

function AskPane({
  topics,
  isPro,
  onShow,
  onOpen,
  pending
}: Readonly<{
  topics: GuideTopic[]
  isPro: boolean
  onShow: (id: string) => void
  onOpen: (view: ViewMode) => void
  /** A feature's "Ask more": asked once, when it comes in. */
  pending: { question: string; at: number } | null
}>): React.ReactElement {
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [waiting, setWaiting] = useState(false)
  // Why the last question has no answer: no chat model, or the ask failed (try again).
  const [missed, setMissed] = useState<{ why: 'no-model' | 'failed'; question: string } | null>(
    null
  )
  const endRef = useRef<HTMLDivElement>(null)
  const firstLook = FIRST_LOOK.map((id) => topics.find((t) => t.id === id)).filter(
    (t): t is GuideTopic => Boolean(t?.media)
  )
  const toEnd = (): void => {
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }))
  }

  /** Ask a question; a retry resends the last one, already on screen, without a second copy. A
   * pick from a "Which one?" list asks with that flow's id, so its steps come back exactly. */
  const ask = async (question: string, retry = false, flowId?: string): Promise<void> => {
    const text = question.trim()
    if (!text || waiting) return
    const history: Turn[] = retry ? turns : [...turns, { role: 'user', content: text }]
    if (!retry) setDraft('')
    // A new question, answered or not, replaces any earlier failure and its Try again.
    setMissed(null)
    // A starter's or a picked flow's answer is built from the guide itself: instant, and there
    // with no model.
    const instant = retry
      ? null
      : flowId
        ? guideFlowStepsById(flowId, topics, currentPlatform())
        : guideStarterAnswer(text, topics)
    if (instant) {
      setTurns([...history, { role: 'assistant', content: instant }])
      toEnd()
      return
    }
    setTurns(history)
    setWaiting(true)
    toEnd()
    // A "how do I…" answer is the app's own steps, found by what the question means when the
    // guide's search model is on this computer, else by its words; the model answers the rest.
    const vector = (await window.api.embedGuideQuestion(text).catch(() => null)) ?? undefined
    const steps = retry ? null : guideStepsAnswer(text, topics, currentPlatform(), vector, turns)
    if (steps) {
      setWaiting(false)
      setTurns([...history, { role: 'assistant', content: steps }])
      toEnd()
      return
    }
    let result: Awaited<ReturnType<typeof window.api.askGuide>> = { error: 'failed' }
    try {
      result = await window.api.askGuide([
        { role: 'system', content: guideGrounding(topics, history, currentPlatform(), vector) },
        ...guideTurnsToSend(history)
      ])
    } catch {
      // The bridge itself failed: the same as a failed ask.
    } finally {
      setWaiting(false)
    }
    if ('answer' in result) setTurns([...history, { role: 'assistant', content: result.answer }])
    else setMissed({ why: result.error, question: text })
    toEnd()
  }

  useEffect(() => {
    if (pending) void ask(pending.question)
    // Asked once per "Ask more"; `at` tells two asks about the same feature apart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.at])

  return (
    <section aria-label="Ask about Off Grid AI" className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pr-2">
        <div className="grid max-w-4xl gap-5 pb-4">
          {turns.length > 0 ? (
            <div className="sticky top-0 z-10 flex justify-end">
              <Button
                size="icon"
                variant="ghost"
                aria-label="New question"
                title="New question"
                disabled={waiting}
                onClick={() => {
                  setTurns([])
                  setDraft('')
                  setMissed(null)
                }}
                data-testid="guide-new"
              >
                <NotePencilIcon className="size-4" />
              </Button>
            </div>
          ) : null}
          {turns.length === 0 ? (
            <div className="og-guide-in grid gap-5">
              <div>
                <h2 className="text-2xl font-light text-neutral-100">Ask about Off Grid AI</h2>
                <p className="mt-1 text-sm text-neutral-400">
                  What it can do on this computer, your phone or in your browser. Answered by your
                  chat model.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {STARTERS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void ask(s)}
                    className="rounded-full border border-neutral-800 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:border-green-500/60 hover:text-neutral-100"
                  >
                    {s}
                  </button>
                ))}
              </div>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {firstLook.map((t) => (
                  <figure key={t.id} className="grid content-start gap-1.5">
                    <MediaFrame topic={t} height="h-40" onClick={() => onShow(t.id)} />
                    <figcaption className="truncate text-sm text-neutral-300">{t.label}</figcaption>
                  </figure>
                ))}
              </div>
            </div>
          ) : null}
          {turns.map((turn, i) =>
            turn.role === 'user' ? (
              <p
                key={i}
                className="og-guide-in ml-auto w-fit max-w-[80%] rounded-lg bg-green-500/15 px-3 py-2 text-sm text-neutral-100"
              >
                {turn.content}
              </p>
            ) : (
              <div key={i} className="og-guide-in grid gap-4 text-sm text-neutral-200">
                <TypedAnswer
                  blocks={guideAnswerBlocks(answerParts(turn.content, topics))}
                  onGrow={() => endRef.current?.scrollIntoView({ block: 'end' })}
                >
                  {(blocks) =>
                    blocks.map((block, j) =>
                      block.kind === 'text' ? (
                        <div key={j} className="min-w-0">
                          <ChatMarkdown content={block.text} />
                        </div>
                      ) : block.kind === 'picks' ? (
                        <div
                          key={j}
                          className="grid w-full max-w-xl divide-y divide-white/5 overflow-hidden rounded-xl border border-white/10"
                        >
                          {block.picks.map((pick) => (
                            <button
                              key={pick.id}
                              type="button"
                              disabled={waiting}
                              onClick={() => void ask(pick.label, false, pick.id)}
                              className="flex items-center gap-3 px-4 py-2.5 text-left text-neutral-200 transition-colors hover:bg-white/5 active:bg-white/10 disabled:opacity-50"
                              data-testid={`guide-pick-${pick.id}`}
                            >
                              <span className="min-w-0 flex-1">{pick.label}</span>
                              <CaretRightIcon
                                className="size-4 shrink-0 text-neutral-500"
                                aria-hidden
                              />
                            </button>
                          ))}
                        </div>
                      ) : block.kind === 'nexts' ? (
                        <div
                          key={j}
                          className="flex max-w-xl flex-wrap gap-2"
                          aria-label="Follow-ups"
                        >
                          {block.nexts.map((next) => (
                            <button
                              key={next.id}
                              type="button"
                              disabled={waiting}
                              onClick={() => void ask(next.label, false, next.id)}
                              className="rounded-full border border-white/10 px-3 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-white/5 hover:text-neutral-100 active:bg-white/10 disabled:opacity-50"
                              data-testid={`guide-next-${next.id}`}
                            >
                              {next.label}
                            </button>
                          ))}
                        </div>
                      ) : block.topics.length === 1 && block.topics[0] ? (
                        <AnswerCard
                          key={j}
                          topic={block.topics[0]}
                          isPro={isPro}
                          onShow={onShow}
                          onOpen={onOpen}
                        />
                      ) : (
                        <div key={j} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                          {block.topics.map((t) => (
                            <AnswerTile key={t.id} topic={t} onShow={onShow} />
                          ))}
                        </div>
                      )
                    )
                  }
                </TypedAnswer>
              </div>
            )
          )}
          {waiting ? (
            <p className="animate-pulse text-sm text-neutral-500" role="status">
              Thinking…
            </p>
          ) : null}
          {missed?.why === 'no-model' ? (
            <div className="og-guide-in grid gap-2 text-sm text-neutral-400" role="status">
              <p>No chat model yet. Load one, then ask again.</p>
              <Button
                size="sm"
                variant="outline"
                className="w-fit"
                onClick={() => onOpen('models')}
              >
                Open Models
              </Button>
            </div>
          ) : missed ? (
            <div className="og-guide-in grid gap-2 text-sm text-neutral-400" role="status">
              <p>No answer came back.</p>
              <Button
                size="sm"
                variant="outline"
                className="w-fit"
                onClick={() => void ask(missed.question, true)}
              >
                Try again
              </Button>
            </div>
          ) : null}
          <div ref={endRef} />
        </div>
      </div>
      <form
        className="mt-3 flex w-full max-w-4xl shrink-0 items-center gap-2 rounded-xl border border-neutral-800 bg-white/[0.02] py-2 pl-4 pr-2 focus-within:border-green-500/60"
        onSubmit={(e) => {
          e.preventDefault()
          void ask(draft)
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask anything about Off Grid AI"
          aria-label="Your question"
          className="min-w-0 flex-1 bg-transparent text-sm text-neutral-100 outline-none placeholder:text-neutral-500"
        />
        <Button
          type="submit"
          size="icon"
          disabled={!draft.trim() || waiting}
          aria-label="Ask"
          title="Ask"
        >
          <PaperPlaneRightIcon className="h-4 w-4" />
        </Button>
      </form>
    </section>
  )
}

function NavRow({
  active,
  onClick,
  icon: Icon,
  label,
  locked
}: Readonly<{
  active: boolean
  onClick: () => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: React.ComponentType<any>
  label: string
  locked?: boolean
}>): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
        active
          ? 'bg-green-500/10 text-neutral-100'
          : 'text-neutral-400 hover:bg-white/[0.04] hover:text-neutral-100'
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {locked ? <LockSimpleIcon className="h-3 w-3 shrink-0" aria-label="Pro" /> : null}
    </button>
  )
}

/**
 * "What it does for you": ask about anything, or pick a feature to see it, what it does and a
 * way in. Covers this app, the phone app and the browser extension. The list and the pane
 * scroll on their own, so picking something never moves the page. The Ask pane stays mounted
 * while a feature is shown, so the conversation is there when you come back.
 */
export function FeatureGuide({
  isPro,
  onOpen,
  picks
}: Readonly<{
  isPro: boolean
  onOpen: (view: ViewMode) => void
  /**
   * Onboarding's "How it works": only these topics, in this order, as "Your picks", starting on
   * the first. The footer goes under each one (Get Pro, connections).
   */
  picks?: {
    ids: string[]
    footer?: (topic: GuideTopic) => ReactNode
    /** Under the list of picks: onboarding's where-it-runs line and opt-in. */
    navFooter?: ReactNode
  }
}>): React.ReactElement {
  const topics = useMemo(() => guideTopics(currentPlatform()), [])
  // A pick this platform does not have yet still shows, with a line saying so.
  const withUnsupported = useMemo(
    () => (picks ? guideTopics(currentPlatform(), { unsupported: true }) : topics),
    [picks, topics]
  )
  const picked = useMemo(
    () =>
      picks?.ids
        .map((id) => withUnsupported.find((t) => t.id === id))
        .filter((t): t is GuideTopic => Boolean(t)) ?? [],
    [picks?.ids, withUnsupported]
  )
  const [selectedId, setSelectedId] = useState(() => picked[0]?.id ?? ASK)
  const [pending, setPending] = useState<{ question: string; at: number } | null>(null)
  const selected = withUnsupported.find((t) => t.id === selectedId)

  const askRow = (
    <NavRow
      active={!selected}
      onClick={() => setSelectedId(ASK)}
      icon={SparkleIcon}
      label="Ask about Off Grid AI"
    />
  )
  const body = (
    <div className="grid min-h-0 flex-1 gap-8 md:grid-cols-[220px_minmax(0,1fr)]">
      <nav
        aria-label="Features"
        className={cn(
          'min-h-0 overflow-y-auto pr-1',
          picks ? 'flex flex-col gap-5' : 'grid content-start gap-5'
        )}
      >
        {picks ? null : askRow}
        {picks ? (
          <section aria-labelledby="guide-your-picks">
            <h2
              id="guide-your-picks"
              className="pb-1.5 pl-2 font-mono text-[10px] uppercase tracking-widest text-neutral-500"
            >
              Your picks
            </h2>
            <ul className="grid gap-0.5">
              {picked.map((t) => (
                <li key={t.id}>
                  <NavRow
                    active={t.id === selectedId}
                    onClick={() => setSelectedId(t.id)}
                    icon={t.icon}
                    label={t.label}
                  />
                </li>
              ))}
              <li>{askRow}</li>
            </ul>
          </section>
        ) : null}
        {picks?.navFooter ? <div className="mt-auto grid gap-4">{picks.navFooter}</div> : null}
        {(picks ? [] : GUIDE_GROUPS).map((group) => {
          const inGroup = topics.filter((t) => t.group === group.id)
          if (inGroup.length === 0) return null
          return (
            <section key={group.id} aria-labelledby={`guide-${group.id}`}>
              <h2
                id={`guide-${group.id}`}
                className="pb-1.5 pl-2 font-mono text-[10px] uppercase tracking-widest text-neutral-500"
              >
                {group.title}
              </h2>
              <ul className="grid gap-0.5">
                {inGroup.map((t) => (
                  <li key={t.id}>
                    <NavRow
                      active={t.id === selectedId}
                      onClick={() => setSelectedId(t.id)}
                      icon={t.icon}
                      label={t.label}
                      locked={t.pro && !isPro && Boolean(t.route)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </nav>
      <div className="min-h-0 min-w-0">
        <div className={cn('h-full', selected && 'hidden')}>
          <AskPane
            topics={topics}
            isPro={isPro}
            onShow={setSelectedId}
            onOpen={onOpen}
            pending={pending}
          />
        </div>
        {selected ? (
          <div key={selected.id} className="h-full overflow-y-auto pr-2">
            <TopicDetail
              topic={selected}
              isPro={isPro}
              onOpen={onOpen}
              onAsk={(question) => {
                setPending({ question, at: Date.now() })
                setSelectedId(ASK)
              }}
              mediaHeight={picks ? 'h-[34vh]' : undefined}
              footer={picks?.footer?.(selected)}
              quiet={Boolean(picks)}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
  if (picks) return body
  return (
    <PageShell
      fill
      title="What it does for you"
      eyebrow="Off Grid AI"
      description="Everything runs on your own computer and phone. Ask, or pick a feature to see it."
    >
      {body}
    </PageShell>
  )
}
