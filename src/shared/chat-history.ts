import { conversationSummaryTurn } from '@offgrid/models'
import { formatDay } from '@offgrid/rag/records'
import { versionContent, type ResponseVersion } from './chat-versions'
// Pure builder for the model-facing history of a chat send. Kept Electron-free and
// component-free so it's unit-tested directly — and, more importantly, so the
// history is a function of the messages you PASS it, forcing the caller to pass the
// TARGET conversation's messages.
//
// D8: sendMessage used to build history from `messages` — the ACTIVE tab's slice —
// even for a send bound to a different conversation (a drained queue item, or a
// regen fired while another tab is focused). The model then answered one
// conversation with another's transcript. The fix is to build from the target
// conversation's own messages; this function makes that the only option.

export interface HistoryTurn {
  role: string
  content: string
  variants?: ResponseVersion[]
  variantIndex?: number
  context?: {
    taskGuidance?: unknown
    attachments?: { name: string; kind: string; text?: string }[]
    /** On a compaction notice: the summary that stands in for every turn before it. */
    compactionSummary?: string
  } | null
  attachments?: { name: string; kind: string; text?: string }[]
  notice?: boolean
  /** When the turn was written, epoch ms. Earlier days get a date marker in the replay. */
  createdAt?: number
}

function modelContent(turn: HistoryTurn): string {
  if (turn.role !== 'user') {
    const index = turn.variantIndex
    const selected =
      turn.role === 'assistant' &&
      typeof index === 'number' &&
      Number.isInteger(index) &&
      index >= 0
        ? turn.variants?.[index]
        : undefined
    return versionContent(selected, turn.content)
  }
  // Attached documents are not replayed here: main rebuilds them for every turn from the
  // conversation (documents/chat-turn.ts). Replaying their full text made every follow-up overflow
  // and compact the document away. The turn keeps only a note of what was attached.
  const attachments = turn.attachments ?? turn.context?.attachments ?? []
  const names = attachments
    .filter(
      (attachment) => attachment.kind !== 'image' && (attachment.text || attachment.kind === 'pdf')
    )
    .map((attachment) => attachment.name)
  return names.length ? `[Attached: ${names.join(', ')}]\n${turn.content}` : turn.content
}

export const EARLIER_CHAT_EXCERPTS_PREFIX = 'Earlier chat excerpts'

function localDay(ms: number): number {
  const day = new Date(ms)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/** The turn's time, when it has a usable one. */
function writtenAt(turn: HistoryTurn): Pick<HistoryTurn, 'createdAt'> {
  const at = turn.createdAt
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? { createdAt: at } : {}
}

/** A replayed chat that spans days says so: the first turn of each earlier day starts with that
 *  day's date, so an old "today" or "tomorrow" is not read as now. A chat held all today gets no
 *  marker; after an earlier day, the first turn of today is marked as today. The turn being
 *  answered counts as now when it has no time. */
function withDayMarkers(turns: HistoryTurn[], now: number): HistoryTurn[] {
  const today = localDay(now)
  let markedDay: number | null = null
  return turns.map((turn, index) => {
    const at = turn.createdAt ?? (index === turns.length - 1 ? now : undefined)
    if (at === undefined) return turn
    const day = localDay(at)
    if (day === markedDay || (day === today && markedDay === null)) return turn
    markedDay = day
    const marker =
      day === today ? `[Today — ${formatDay(now)}]` : `[Earlier conversation — ${formatDay(at)}]`
    return { ...turn, content: `${marker}\n${turn.content}` }
  })
}

/** Build bounded history for a send.
 *  - regen: the latest user turn is already in the thread → keep up to and
 *    including it (drop anything after).
 *  - normal send: append the new user turn.
 *  `convMsgs` MUST be the target conversation's messages. */
export function buildSendHistory<T extends HistoryTurn>(
  convMsgs: readonly T[],
  regen: boolean,
  newUserText: string,
  limit = 20,
  contextWindowTokens?: number,
  now = Date.now()
): HistoryTurn[] {
  // Task guidance is shown in Chat for continuity, but the operator already
  // consumed it. Do not replay it as another user prompt to the resident LLM.
  const lastCompaction = convMsgs.findLastIndex(
    (message) => message.notice && message.content === '_Compacted_'
  )
  const beforeNotice = convMsgs
    .slice(0, lastCompaction < 0 ? 0 : lastCompaction)
    .filter((message) => !message.context?.taskGuidance && !message.notice)
  // The notice is inserted after the user turn that triggered compaction.
  // Keep that active turn intact for the next reply as well.
  const retainedUserTurn = beforeNotice.at(-1)?.role === 'user' ? beforeNotice.at(-1) : undefined
  const preCompactionTurns = retainedUserTurn ? beforeNotice.slice(0, -1) : beforeNotice
  const preCompactionExcerpts = preCompactionTurns.length
    ? [
        preCompactionTurns[0]!,
        ...preCompactionTurns.slice(-3).filter((turn) => turn !== preCompactionTurns[0])
      ]
    : []
  const preCompactionLabels = preCompactionExcerpts.map(
    (turn) =>
      `${turn.role === 'assistant' ? 'Assistant' : 'User'}: ${(turn.role === 'assistant' ? modelContent(turn) : turn.content).slice(0, 90)}`
  )
  // A saved summary stands in for the compacted turns; older notices without one keep excerpts.
  const compactionSummary =
    lastCompaction >= 0 ? convMsgs[lastCompaction]!.context?.compactionSummary : undefined
  const flat = [
    ...(compactionSummary && preCompactionTurns.length
      ? [conversationSummaryTurn(compactionSummary)]
      : preCompactionLabels.length
        ? [
            {
              role: 'user',
              content:
                `${EARLIER_CHAT_EXCERPTS_PREFIX} (${preCompactionTurns.length} turns; some details omitted): ${preCompactionLabels.join(' | ')}`.slice(
                  0,
                  400
                ),
              ...writtenAt(preCompactionTurns[0]!)
            }
          ]
        : []),
    ...(retainedUserTurn ? [retainedUserTurn] : []),
    ...convMsgs
      .slice(lastCompaction + 1)
      .filter((message) => !message.context?.taskGuidance && !message.notice)
  ].map((m): HistoryTurn => ({ role: m.role, content: modelContent(m), ...writtenAt(m) }))
  let base: HistoryTurn[]
  if (regen) {
    const lastUserIdx = flat.map((m) => m.role).lastIndexOf('user')
    base = lastUserIdx >= 0 ? flat.slice(0, lastUserIdx + 1) : flat
  } else {
    base = [...flat, { role: 'user', content: newUserText }]
  }
  if (base.length === 0) return []
  // Day markers go on last, so excerpts and per-turn cuts never trim one away. Each is one short
  // line, inside the room the estimate below leaves.
  const estimatedTokens = Math.ceil(JSON.stringify(base).length / 4)
  if (contextWindowTokens && estimatedTokens < contextWindowTokens * 0.8)
    return withDayMarkers(base, now)
  const effectiveLimit =
    contextWindowTokens && estimatedTokens >= contextWindowTokens * 0.8 && base.length > 2
      ? Math.min(limit, Math.max(2, Math.floor(base.length / 2)))
      : limit
  if (effectiveLimit <= 1) return withDayMarkers(base.slice(-1), now)
  // The active turn is never shortened. Prior turns share a fixed budget so a
  // few very large messages cannot exhaust the model context by themselves.
  const recent = base.length <= effectiveLimit ? base : base.slice(-(effectiveLimit - 1))
  const older = base.slice(0, base.length - recent.length)
  const excerptTurns = older.length
    ? [older[0]!, ...older.slice(-3).filter((turn) => turn !== older[0])]
    : []
  const excerpts = excerptTurns.map(
    (turn) => `${turn.role === 'assistant' ? 'Assistant' : 'User'}: ${turn.content.slice(0, 90)}`
  )
  const prior: HistoryTurn[] = [
    ...(older.length
      ? [
          {
            role: 'user',
            content: `${EARLIER_CHAT_EXCERPTS_PREFIX} (${older.length} turns; some details omitted): ${excerpts.join(' | ')}`,
            ...writtenAt(older[0]!)
          }
        ]
      : []),
    ...recent.slice(0, -1)
  ]
  const charsPerTurn = Math.max(1, Math.floor(3000 / Math.max(1, prior.length)))
  return withDayMarkers(
    [
      ...prior.map((turn) => ({
        ...turn,
        content:
          turn.content.length > charsPerTurn
            ? `${turn.content.slice(0, charsPerTurn - 1)}…`
            : turn.content
      })),
      recent[recent.length - 1]!
    ],
    now
  )
}
