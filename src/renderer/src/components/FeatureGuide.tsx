import { useMemo, useRef, useState } from 'react'
import {
  ArrowSquareOutIcon,
  CheckIcon,
  LockSimpleIcon,
  PaperPlaneRightIcon,
  SparkleIcon
} from '@phosphor-icons/react'
import { PageShell } from './PageShell'
import { Button } from './ui/button'
import { ChatMarkdown } from './ChatMarkdown'
import { currentPlatform } from '@renderer/lib/device'
import { openExternal } from '@renderer/constants/links'
import { cn } from '@renderer/lib/utils'
import type { ViewMode } from '@renderer/lib/view-modes'
import {
  GUIDE_GROUPS,
  answerParts,
  guideSystemPrompt,
  guideTopics,
  type GuideTopic
} from './guide/guideKnowledge'
import type { GuideMedia } from './guide/guideMedia'

type Turn = { role: 'user' | 'assistant'; content: string }

const ASK = 'ask'

const STARTERS = [
  'What can it do with my meetings?',
  'What works on my phone?',
  'How do I fix my writing in any app?',
  'What does the browser extension do?'
]

/** A few features worth a first look, shown under the Ask box before anything is asked. */
const FIRST_LOOK = ['scribe', 'notes', 'explore', 'meetings', 'phone', 'extension']

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
      {topic.where} · {topic.pro ? 'Pro' : 'Free'}
    </span>
  )
}

function TopicAction({
  topic,
  isPro,
  onOpen,
  size = 'default'
}: Readonly<{
  topic: GuideTopic
  isPro: boolean
  onOpen: (view: ViewMode) => void
  size?: 'default' | 'sm'
}>): React.ReactElement | null {
  if (topic.route) {
    const route = topic.route
    return (
      <Button size={size} onClick={() => onOpen(route)}>
        {topic.pro && !isPro ? <LockSimpleIcon className="h-4 w-4" /> : null}
        Open {topic.label}
      </Button>
    )
  }
  if (!topic.url) return null
  const url = topic.url
  return (
    <Button size={size} variant="outline" onClick={() => openExternal(url)}>
      Get it
      <ArrowSquareOutIcon className="h-4 w-4" />
    </Button>
  )
}

function TopicDetail({
  topic,
  isPro,
  onOpen
}: Readonly<{
  topic: GuideTopic
  isPro: boolean
  onOpen: (view: ViewMode) => void
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
        <TopicAction topic={topic} isPro={isPro} onOpen={onOpen} />
      </div>
      <MediaFrame topic={topic} height="h-[56vh]" />
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
    </article>
  )
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

function AskPane({
  topics,
  isPro,
  onShow,
  onOpen
}: Readonly<{
  topics: GuideTopic[]
  isPro: boolean
  onShow: (id: string) => void
  onOpen: (view: ViewMode) => void
}>): React.ReactElement {
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [waiting, setWaiting] = useState(false)
  // Why the last question has no answer: no chat model, or the ask failed (try again).
  const [missed, setMissed] = useState<{ why: 'no-model' | 'failed'; question: string } | null>(
    null
  )
  const endRef = useRef<HTMLDivElement>(null)
  const system = useMemo(() => guideSystemPrompt(topics), [topics])
  const firstLook = FIRST_LOOK.map((id) => topics.find((t) => t.id === id)).filter(
    (t): t is GuideTopic => Boolean(t?.media)
  )
  const toEnd = (): void => {
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }))
  }

  /** Ask a question; a retry resends the last one, already on screen, without a second copy. */
  const ask = async (question: string, retry = false): Promise<void> => {
    const text = question.trim()
    if (!text || waiting) return
    const history: Turn[] = retry ? turns : [...turns, { role: 'user', content: text }]
    setTurns(history)
    if (!retry) setDraft('')
    setWaiting(true)
    setMissed(null)
    toEnd()
    // A question left unanswered stays on screen but is not sent: two user turns in a row
    // break models that need user and assistant turns to alternate.
    const sent = history.filter(
      (t, i) =>
        t.role !== 'user' || i === history.length - 1 || history[i + 1]?.role === 'assistant'
    )
    let result: Awaited<ReturnType<typeof window.api.askGuide>> = { error: 'failed' }
    try {
      result = await window.api.askGuide([{ role: 'system', content: system }, ...sent.slice(-7)])
    } catch {
      // The bridge itself failed: the same as a failed ask.
    } finally {
      setWaiting(false)
    }
    if ('answer' in result) setTurns([...history, { role: 'assistant', content: result.answer }])
    else setMissed({ why: result.error, question: text })
    toEnd()
  }

  return (
    <section aria-label="Ask about Off Grid AI" className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pr-2">
        <div className="grid max-w-4xl gap-5 pb-4">
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
                {answerParts(turn.content, topics).map((part, j) =>
                  part.kind === 'text' ? (
                    <div key={j} className="min-w-0">
                      <ChatMarkdown content={part.text} />
                    </div>
                  ) : (
                    <AnswerCard
                      key={j}
                      topic={part.topic}
                      isPro={isPro}
                      onShow={onShow}
                      onOpen={onOpen}
                    />
                  )
                )}
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
  onOpen
}: Readonly<{ isPro: boolean; onOpen: (view: ViewMode) => void }>): React.ReactElement {
  const topics = useMemo(() => guideTopics(currentPlatform()), [])
  const [selectedId, setSelectedId] = useState(ASK)
  const selected = topics.find((t) => t.id === selectedId)

  return (
    <PageShell
      fill
      title="What it does for you"
      eyebrow="Off Grid AI"
      description="Everything runs on your own computer and phone. Ask, or pick a feature to see it."
    >
      <div className="grid min-h-0 flex-1 gap-8 md:grid-cols-[220px_minmax(0,1fr)]">
        <nav
          aria-label="Features"
          className="grid min-h-0 content-start gap-5 overflow-y-auto pr-1"
        >
          <NavRow
            active={!selected}
            onClick={() => setSelectedId(ASK)}
            icon={SparkleIcon}
            label="Ask about Off Grid AI"
          />
          {GUIDE_GROUPS.map((group) => {
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
            <AskPane topics={topics} isPro={isPro} onShow={setSelectedId} onOpen={onOpen} />
          </div>
          {selected ? (
            <div key={selected.id} className="h-full overflow-y-auto pr-2">
              <TopicDetail topic={selected} isPro={isPro} onOpen={onOpen} />
            </div>
          ) : null}
        </div>
      </div>
    </PageShell>
  )
}
