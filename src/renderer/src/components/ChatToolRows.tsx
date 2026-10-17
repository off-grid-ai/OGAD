import { useState, type ReactNode } from 'react'
import type { ChatStreamTool, ProjectedSyncedTool } from '@offgrid/sync'
import { parseSearchBlock, type SearchBlockPassage } from '@offgrid/rag/documents'
import {
  CaretDown,
  CircleNotch,
  SidebarSimple,
  StopCircle,
  WarningCircle,
  X
} from '@phosphor-icons/react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Button } from '@offgrid/operator-ui/operator/coss/button'
import { AutoHeight } from '@offgrid/operator-ui/operator/presence'
import { TextShimmer } from '@offgrid/operator-ui/operator/text-shimmer'
import {
  ToolTimeline,
  type ToolTimelineProps,
  type ToolTraceEntry
} from '@offgrid/operator-ui/operator/workflows/tool-timeline'
import { ChatMarkdown } from './ChatMarkdown'
import type { AssistantTimelineEntry } from '@renderer/lib/message-persistence'
import { type TaskSession, useTaskSessionsForReferences } from '@renderer/lib/task-session-store'
import {
  closeTaskWorkspace,
  openTaskSidePanel,
  useTaskWorkspaceOpen
} from '@renderer/lib/task-side-panel'
import { ComputerUseStepDetails } from './tasks/ComputerUseStepDetails'
import { RetryTaskButton } from './tasks/RetryTaskButton'
import { taskReferenceFromResult, visibleToolResult } from './chat-tool-projection'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

type DisplayTool =
  | Pick<ProjectedSyncedTool, 'name' | 'arguments' | 'result' | 'status' | 'durationMs' | 'error'>
  | ChatStreamTool

interface ChatToolRowsProps {
  tools?: readonly DisplayTool[]
  /** A host-rendered thinking block (header included), shown as is in the timeline. */
  thinking?: ReactNode
  /** Whether the thinking row has content beyond a waiting indicator. */
  thinkingHasContent?: boolean
  /** The raw reasoning. When given, the timeline draws its own aligned thinking row from it
   * instead of the host block, so the checkpoint, title and text share one edge. The row still
   * appears only where the host gives a thinking block; a labelled or host-supplied block (e.g. an
   * Enhanced prompt) leaves this undefined and keeps its own title. */
  thinkingText?: string
  /** Live status shown below, but outside, the ordered work timeline. */
  footer?: ReactNode
  timeline?: readonly AssistantTimelineEntry[]
  thinkingLive?: boolean
  memorySources?: { count: number; content: ReactNode }
  /** The task that belongs to this live Chat turn before its tool result contains a task id. */
  liveTask?: TaskSession
  /** Open the timeline while this response is live, then close it when the response completes. */
  live?: boolean
  /** A final or stopped response closes work even if an earlier tool retained running state. */
  settled?: boolean
  /** The user stopped this turn before normal completion. */
  stopped?: boolean
  /** The model failed after it had started this turn. */
  failed?: boolean
}

type WorkStatus = 'running' | 'complete' | 'failed' | 'stopped' | 'needs attention'

type ToolEntryState = Extract<ToolTraceEntry, { kind: 'tool' }>['state']

/**
 * The timeline's step badge speaks the library's states; the product keeps its own words in each
 * step's name. Work waiting on the person stays a collapsible step (a breathing ring) so its row
 * keeps its accessible name and its task.
 */
function pageSpan(pages: readonly number[]): string {
  if (!pages.length) return ''
  const first = pages[0]!
  const last = pages[pages.length - 1]!
  return first === last ? `p. ${first}` : `pp. ${first}–${last}`
}

/** One step for the documents an answer read: a thin row per document, pages it read. */
function documentsEntry(
  entry: Extract<AssistantTimelineEntry, { kind: 'documents' }>
): ToolTraceEntry {
  return {
    id: 'documents',
    kind: 'tool',
    name: entry.label,
    ariaLabel: entry.label,
    state: 'success',
    description: entry.documents.map((document) => document.name).join(', '),
    summary: 'complete',
    result: (
      <ul className="divide-y divide-border/60 text-sm">
        {entry.documents.map((document) => (
          <li key={document.name} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
            <span className="min-w-0 truncate text-foreground">{document.name}</span>
            <span className="text-xs text-muted-foreground">
              {document.whole
                ? 'read in full'
                : `${document.passages} passage${document.passages === 1 ? '' : 's'}${
                    document.pages.length ? ` · ${pageSpan(document.pages)}` : ''
                  }`}
            </span>
            {document.readPages !== undefined ? (
              <span className="text-xs text-muted-foreground/70">
                {document.readPages ? `pages 1–${document.readPages} read so far` : 'still reading'}
              </span>
            ) : null}
            {document.unreadablePages ? (
              <span className="text-xs text-muted-foreground/70">
                {document.unreadablePages} scanned page{document.unreadablePages === 1 ? '' : 's'}{' '}
                not read yet
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    )
  }
}

/** "5 passages from 2 files". */
function passagesSummary(passages: readonly SearchBlockPassage[]): string {
  const files = new Set(passages.map((passage) => passage.document)).size
  return `${passages.length} passage${passages.length === 1 ? '' : 's'} from ${files} file${
    files === 1 ? '' : 's'
  }`
}

/** Results saved before passages were tagged: "[1] file.pdf (part 12):" blocks. */
function legacyKnowledgePassages(result: string): SearchBlockPassage[] {
  const passages: SearchBlockPassage[] = []
  for (const match of result.matchAll(
    /^\[(\d+)\] (.+?) \(part (\d+)\):\n([\s\S]*?)(?=\n\n---\n\n|\n\nProject conversations:|$(?![\s\S]))/gm
  )) {
    passages.push({
      id: match[1]!,
      document: match[2]!,
      label: `part ${match[3]}`,
      text: match[4]!.trim()
    })
  }
  return passages
}

/** Long tool output folds to a few lines; the rest opens on request (progressive disclosure). */
const LONG_RESULT_CHARS = 600

function FoldedResult({ content }: Readonly<{ content: string }>): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (content.length <= LONG_RESULT_CHARS) return <ChatMarkdown content={content} />
  return (
    <div className="space-y-1.5">
      <div
        className={
          open
            ? 'max-h-[400px] overflow-y-auto'
            : 'max-h-24 overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]'
        }
      >
        <ChatMarkdown content={content} />
      </div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
      >
        {open ? 'Show less' : 'Show all'}
      </button>
    </div>
  )
}

/**
 * A search tool's passages: a thin row each (citation tag, file, page, first words), the full
 * passage opening below the row clicked. The tag matches the answer's [S#] citations.
 */
function SearchPassageList({
  passages
}: Readonly<{ passages: readonly SearchBlockPassage[] }>): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <ul className="max-h-80 divide-y divide-border/60 overflow-y-auto pr-1 text-sm">
      {passages.map((passage, index) => {
        const key = `${passage.id}:${index}`
        const place = passage.label ?? (passage.page === undefined ? '' : `p. ${passage.page}`)
        return (
          <li key={key}>
            <Collapsible open={open === key} onOpenChange={(next) => setOpen(next ? key : null)}>
              <CollapsibleTrigger className="group flex w-full min-w-0 items-baseline gap-1.5 py-1.5 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                <span className="shrink-0 rounded-sm bg-muted px-1 font-mono text-[10px] leading-4 tabular-nums">
                  {passage.id}
                </span>
                <span className="min-w-0 max-w-[45%] shrink truncate text-foreground">
                  {passage.document}
                </span>
                {place ? <span className="shrink-0 text-xs">· {place}</span> : null}
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">
                  · {passage.text.slice(0, 240).replace(/\s+/g, ' ').trim()}
                </span>
                <CaretDown
                  aria-hidden="true"
                  weight="bold"
                  className="size-3 shrink-0 self-center opacity-60 transition-transform duration-200 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="offgrid-smooth-collapsible overflow-hidden">
                <p className="whitespace-pre-wrap pb-2 text-xs leading-relaxed text-muted-foreground">
                  {passage.text}
                </p>
              </CollapsibleContent>
            </Collapsible>
          </li>
        )
      })}
    </ul>
  )
}

const ENTRY_STATE: Record<WorkStatus, ToolEntryState> = {
  running: 'running',
  complete: 'success',
  failed: 'error',
  stopped: 'stopped',
  'needs attention': 'pending'
}

type WorkState = Exclude<ToolTimelineProps['state'], 'needs-attention'>

/** The trigger keeps the product's words for each state of the work. */
const STATE_LABELS: Record<WorkState, string> = {
  working: 'Working',
  done: 'Work done',
  stopped: 'Work stopped',
  failed: 'Work failed'
}

/**
 * ToolTimeline's own trigger is a bare text button. This row owns the disclosure instead, so the
 * library's trigger is given no words and removed from layout and the accessibility tree.
 */
const NO_TIMELINE_TRIGGER_LABELS: ToolTimelineProps['stateLabels'] = {
  working: '',
  done: '',
  stopped: '',
  failed: ''
}

/** A finished turn needs no glyph: its steps carry their own ticks, and the words say it is done. */
const STATE_GLYPHS: Record<WorkState, React.JSX.Element | null> = {
  working: (
    <CircleNotch
      aria-hidden="true"
      weight="bold"
      className="size-3.5 shrink-0 text-primary motion-safe:animate-spin"
    />
  ),
  done: null,
  stopped: (
    <StopCircle
      aria-hidden="true"
      weight="fill"
      className="size-3.5 shrink-0 text-muted-foreground"
    />
  ),
  failed: (
    <WarningCircle
      aria-hidden="true"
      weight="fill"
      className="size-3.5 shrink-0 text-destructive"
    />
  )
}

const PROPOSAL_STAGE_LABELS: Record<string, string> = {
  start: 'Started proposal',
  status: 'Checked proposal progress',
  save_website_context: 'Saved website research',
  save_narrative_plan: 'Drafted proposal story',
  revise_narrative_plan: 'Revised proposal story',
  approve_narrative_plan: 'Approved proposal story',
  save_skeleton: 'Built slide plan',
  revise_skeleton: 'Revised slide plan',
  approve_skeleton: 'Approved slide plan',
  save_case_studies: 'Collected supporting proof',
  select_case_studies: 'Selected case studies',
  save_full_copy: 'Wrote slide copy',
  revise_full_copy: 'Revised slide copy',
  regenerate_illustration: 'Regenerated illustration',
  approve_full_copy: 'Approved final deck'
}

const TOOL_LABELS: Record<string, string> = {
  web_use: 'Web Use',
  computer_use: 'Computer Use',
  generate_image: 'Generated image',
  image_generation: 'Generated image',
  search_memory: 'Searched memory',
  search_knowledge_base: 'Searched knowledge base',
  search_documents: 'Searched documents',
  search_replay: 'Searched activity',
  search_meetings: 'Searched meetings',
  web_search: 'Searched the web',
  brave_search: 'Searched the web',
  read_url: 'Read web page',
  search_messages: 'Searched messages',
  list_folder: 'Listed folder',
  list_directory: 'Listed folder',
  read_folder: 'Read folder',
  read_file: 'Read file',
  write_file: 'Created output',
  create_file: 'Created output',
  save_file: 'Saved output',
  action_approval: 'Requested approval',
  request_approval: 'Requested approval'
}

/** Tools whose result is passage blocks (`searchBlock`), shown as rows instead of raw text. */
const PASSAGE_SEARCH_TOOLS = new Set(['search_knowledge_base', 'search_documents'])

function parseArguments(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function normalizedToolKey(name: string): string {
  return name
    .replace(/^mcp__\d+__/, '')
    .replace(/^mcp_\d+_+/, '')
    .replace(/^pro:/, '')
    .toLowerCase()
}

function taskKindForTool(name: string): TaskSession['kind'] | undefined {
  const key = normalizedToolKey(name)
  if (key === 'web_use') return 'web_use'
  if (key === 'computer_use') return 'computer_use'
  return undefined
}

function titleFromIdentifier(name: string): string {
  const clean = normalizedToolKey(name)
    .replace(/[:._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return 'Used tool'
  return clean.charAt(0).toUpperCase() + clean.slice(1)
}

function workStepLabel(tool: DisplayTool): string {
  const key = normalizedToolKey(tool.name)
  if (key === 'proposal_deck') {
    const action = String(
      parseArguments('arguments' in tool ? tool.arguments : undefined)?.action ?? ''
    )
    return PROPOSAL_STAGE_LABELS[action] ?? 'Updated proposal deck'
  }
  return TOOL_LABELS[key] ?? titleFromIdentifier(key)
}

function workStatus(tool: DisplayTool): WorkStatus {
  const result = visibleToolResult(tool.result)
  if ('error' in tool && tool.error?.trim()) return 'failed'
  if (/^\s*(error|failed)\s*:/i.test(result)) return 'failed'
  if (tool.status === 'failed') return 'failed'
  if (tool.status === 'pending' || tool.status === 'cancelled') return 'needs attention'
  if (tool.status === 'running') return 'running'
  return 'complete'
}

function shortResult(tool: DisplayTool, status = workStatus(tool), taskSummary?: string): string {
  if (taskSummary?.trim()) return taskSummary.trim()
  if (status === 'running') return 'In progress.'
  if (status === 'needs attention') return 'Waiting for your attention.'
  const key = normalizedToolKey(tool.name)
  if (key === 'read_file') {
    return status === 'failed' ? 'The file could not be read.' : 'Read the selected file.'
  }
  if (key === 'read_folder') {
    return status === 'failed' ? 'The folder could not be read.' : 'Read the selected folder.'
  }
  if (key === 'list_folder' || key === 'list_directory') {
    return status === 'failed' ? 'The folder could not be listed.' : 'Listed the selected folder.'
  }
  if (key === 'write_file' || key === 'create_file' || key === 'save_file') {
    return status === 'failed' ? 'The output could not be saved.' : 'Saved the requested output.'
  }
  if (key === 'generate_image' || key === 'image_generation') {
    return status === 'failed' ? 'The image could not be created.' : 'Created the requested image.'
  }
  if (key === 'web_search' || key === 'brave_search') return 'Search results are ready.'
  if (key === 'read_url') return 'Read the selected web page.'
  if (key === 'search_meetings' || PASSAGE_SEARCH_TOOLS.has(key)) {
    const result = visibleToolResult(tool.result).trim()
    if (result) return result.split(/\r?\n/, 1)[0]!
  }
  if (key.startsWith('search_')) return 'Found matching items.'
  if (status === 'failed') return 'This step failed. Open it for details.'
  const value = ('error' in tool && tool.error?.trim()) || visibleToolResult(tool.result)
  if (!value) return 'Step finished.'
  const firstLine = value
    .split(/\r?\n/, 1)[0]!
    .replace(/\/(?:Users|home)\/[^\s]+/g, '[local file]')
    .replace(/[A-Za-z]:\\[^\s]+/g, '[local file]')
    .trim()
  if (!firstLine || firstLine.startsWith('{') || firstLine.startsWith('[')) {
    return 'Result is ready.'
  }
  return firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine
}

function taskWorkStatus(task: TaskSession | undefined): WorkStatus | undefined {
  if (!task) return undefined
  if (task.status === 'failed') return 'failed'
  // A task the person stopped did not fail.
  if (task.status === 'stopped') return 'stopped'
  if (task.status === 'paused' || task.status === 'waiting') return 'needs attention'
  if (task.status === 'running' || task.status === 'reconnecting') return 'running'
  return 'complete'
}

function linkedTaskForReference(
  tasks: readonly TaskSession[],
  reference: string | undefined
): TaskSession | undefined {
  if (!reference) return undefined
  const referenced = tasks.find((task) => task.taskId === reference)
  const journeyId = referenced?.journeyId ?? reference
  return tasks
    .filter((task) => task.taskId === reference || task.journeyId === journeyId)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.taskId.localeCompare(a.taskId))[0]
}

function liveTaskToolIndex(
  tools: readonly DisplayTool[],
  liveTask: TaskSession | undefined
): number {
  if (!liveTask) return -1
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index]!
    if (
      !taskReferenceFromResult(tool.result) &&
      workStatus(tool) === 'running' &&
      taskKindForTool(tool.name) === liveTask.kind
    ) {
      return index
    }
  }
  return -1
}

/** One persisted execution timeline for both live previews and durable assistant turns. */
export function ChatToolRows({
  tools,
  thinking,
  thinkingHasContent = Boolean(thinking),
  thinkingText,
  footer,
  timeline,
  thinkingLive = false,
  memorySources,
  liveTask,
  live = false,
  settled = false,
  stopped = false,
  failed = false
}: Readonly<ChatToolRowsProps>): React.JSX.Element | null {
  const taskWorkspaceOpen = useTaskWorkspaceOpen()
  // Web Use can start before toolChat returns its durable tool result. Project one
  // pending row from the live task so the chat reports work at the time it happens.
  // Once the real tool call arrives, it replaces this transient projection.
  const visible: readonly DisplayTool[] = tools?.length
    ? tools
    : memorySources
      ? [{ name: 'search_memory', result: '', status: 'completed' }]
      : !liveTask
        ? []
        : [
            {
              name: liveTask.kind === 'web_use' ? 'web_use' : 'computer_use',
              arguments: '{}',
              result: '',
              status: 'running'
            }
          ]
  const taskReferences = visible.flatMap((tool) => {
    const reference = taskReferenceFromResult(tool.result)
    return reference ? [reference] : []
  })
  const tasks = useTaskSessionsForReferences(taskReferences)
  const liveToolIndex = liveTaskToolIndex(visible, liveTask)
  const projected = visible.map((tool, index) => {
    const taskId = taskReferenceFromResult(tool.result)
    const linkedTask =
      linkedTaskForReference(tasks, taskId) ?? (index === liveToolIndex ? liveTask : undefined)
    return { tool, taskId, linkedTask, status: taskWorkStatus(linkedTask) ?? workStatus(tool) }
  })
  const workIsLive =
    live ||
    (!stopped && !failed && !settled && projected.some(({ status }) => status === 'running'))
  const workState: WorkState = workIsLive
    ? 'working'
    : stopped
      ? 'stopped'
      : failed
        ? 'failed'
        : 'done'
  // The caller owns the disclosure: open while the response is live, closed once it settles,
  // and the person's own toggle holds until the work changes state again.
  const [expanded, setExpanded] = useState(workIsLive)
  const [expandedFor, setExpandedFor] = useState(workState)
  if (expandedFor !== workState) {
    setExpandedFor(workState)
    setExpanded(workIsLive)
  }
  if (visible.length === 0 && !thinking && !timeline?.length && !stopped && !failed) return null

  const firstMemoryToolIndex = visible.findIndex(
    (tool) => normalizedToolKey(tool.name) === 'search_memory' && workStatus(tool) === 'complete'
  )
  const ordered: AssistantTimelineEntry[] = timeline?.length
    ? [
        ...timeline,
        ...projected.flatMap((_, index) =>
          timeline.some((entry) => entry.kind === 'tool' && entry.toolIndex === index)
            ? []
            : [{ kind: 'tool' as const, toolIndex: index }]
        )
      ]
    : projected.map((_, index) => ({ kind: 'tool', toolIndex: index }))
  const hasOrderedThinking = ordered.some((entry) => entry.kind === 'thinking')
  // The ephemeral mesh preview retains only its newest tools. Durable toolCalls has every call.
  const toolOffset = Math.max(
    0,
    ordered.filter((entry) => entry.kind === 'tool').length - projected.length
  )

  const entries: ToolTraceEntry[] = []
  const pushThinking = (id: string, render: ReactNode, streaming: boolean): void => {
    entries.push({ id, kind: 'thinking', text: null, render, streaming })
  }
  // The timeline's own thinking row: title shimmers "Thinking" while live, then the reasoning
  // renders through OGAD's markdown, level with its checkpoint.
  const pushReasoning = (id: string, text: string, streaming: boolean): void => {
    entries.push({
      id,
      kind: 'thinking',
      text: text.trim() ? <ChatMarkdown content={text} /> : null,
      streaming
    })
  }
  const liveThinking = (): void => {
    if (thinkingText !== undefined) {
      if (!thinking) return
      if (thinkingText.trim() || workIsLive) {
        // "Thinking" while reasoning still streams, not only while it is waiting for its first words.
        pushReasoning(
          'thinking:live',
          thinkingText,
          workIsLive && (!thinkingHasContent || thinkingLive)
        )
      } else {
        // No reasoning came back: the host block says so ("Thinking unavailable") instead of
        // the turn silently dropping it.
        pushThinking('thinking:live', thinking, false)
      }
      return
    }
    if (thinking) pushThinking('thinking:live', thinking, workIsLive && !thinkingHasContent)
  }

  if (!hasOrderedThinking) liveThinking()
  ordered.forEach((entry, orderIndex) => {
    if (entry.kind === 'thinking') {
      const streaming = thinkingLive && orderIndex === ordered.length - 1
      pushReasoning(`thinking:${orderIndex}`, entry.text, streaming)
      return
    }
    if (entry.kind === 'documents') {
      entries.push(documentsEntry(entry))
      return
    }
    const projectedTool = projected[entry.toolIndex - toolOffset]
    if (!projectedTool) return
    const { tool, linkedTask, status: stepStatus } = projectedTool
    const memoryTool = normalizedToolKey(tool.name) === 'search_memory'
    const showMemorySources = Boolean(
      memorySources && entry.toolIndex === firstMemoryToolIndex + toolOffset
    )
    const sourceCount = memorySources?.count ?? 0
    const stepLabel = showMemorySources
      ? `Searched your memory — ${sourceCount} result${sourceCount === 1 ? '' : 's'}`
      : workStepLabel(tool)
    const result = visibleToolResult(tool.result)
    const passages =
      stepStatus === 'complete' && PASSAGE_SEARCH_TOOLS.has(normalizedToolKey(tool.name))
        ? (() => {
            const tagged = parseSearchBlock(result)
            return tagged.length ? tagged : legacyKnowledgePassages(result)
          })()
        : []
    const error = 'error' in tool ? tool.error?.trim() : undefined
    const taskSummary = linkedTask?.summary?.trim()
    const liveTaskLine = stepStatus === 'running' ? linkedTask?.currentAction?.trim() : undefined
    const rowSummary = liveTaskLine || taskSummary
    const details = taskSummary || error || result
    const durationMs = 'durationMs' in tool ? tool.durationMs : undefined
    const hasComputerDetails = Boolean(linkedTask?.stepDetails?.length)
    const hasDisclosure =
      showMemorySources ||
      (!(memorySources && memoryTool && stepStatus === 'complete') &&
        (Boolean(details) || hasComputerDetails || Boolean(linkedTask)))
    const detail = !hasDisclosure ? undefined : showMemorySources ? (
      <div className="max-h-[400px] overflow-y-auto text-sm">{memorySources?.content}</div>
    ) : passages.length ? (
      <SearchPassageList passages={passages} />
    ) : (
      <AutoHeight className="space-y-2 leading-relaxed text-muted-foreground">
        {details ? <FoldedResult content={details} /> : null}
        <ComputerUseStepDetails details={linkedTask?.stepDetails} />
        {linkedTask ? (
          <div className="flex flex-wrap items-start gap-1.5">
            <TaskDetailsToggle
              open={taskWorkspaceOpen}
              onToggle={() =>
                taskWorkspaceOpen
                  ? closeTaskWorkspace()
                  : openTaskSidePanel({
                      taskId: linkedTask.taskId,
                      kind: linkedTask.kind,
                      detail: true
                    })
              }
            />
            <RetryTaskButton task={linkedTask} />
          </div>
        ) : null}
      </AutoHeight>
    )
    entries.push({
      id: `${tool.name}:${entry.toolIndex}`,
      kind: 'tool',
      name: stepLabel,
      ariaLabel: `${stepLabel}, ${stepStatus}`,
      state: ENTRY_STATE[stepStatus],
      description: showMemorySources
        ? undefined
        : passages.length
          ? passagesSummary(passages)
          : shortResult(tool, stepStatus, rowSummary),
      summary: stepStatus,
      result: detail,
      // A linked task's row opens that task as well as its detail.
      ...(linkedTask
        ? {
            onSelect: () =>
              openTaskSidePanel({ taskId: linkedTask.taskId, kind: linkedTask.kind, detail: true })
          }
        : {}),
      ...(durationMs === undefined ? {} : { time: `${Math.round(durationMs)} ms` })
    })
  })
  if (hasOrderedThinking) liveThinking()

  return (
    <>
      <Collapsible
        open={expanded}
        onOpenChange={setExpanded}
        className="w-full max-w-[85%]"
        aria-busy={workIsLive || undefined}
      >
        <WorkTrigger state={workState} count={entries.length} />
        {/* The clip box reaches 12px left of the content, so a checkpoint's glow is not cut off. */}
        {/* clip, not hidden: an open step's header pins to the chat (library tool timeline),
            which a scroll container here would stop. */}
        <CollapsibleContent className="offgrid-smooth-collapsible -ml-3 overflow-clip pl-3">
          <div className="[&>[data-slot=collapsible]>[data-slot=collapsible-panel]>div]:pb-1 [&>[data-slot=collapsible]>[data-slot=collapsible-panel]>div]:pt-2.5 [&>[data-slot=collapsible]>[data-slot=collapsible-trigger]]:hidden">
            <ToolTimeline
              entries={entries}
              state={workState}
              expanded
              onExpandedChange={() => undefined}
              label={thinking || hasOrderedThinking ? 'Thinking and tool calls' : 'Tool calls'}
              stateLabels={NO_TIMELINE_TRIGGER_LABELS}
              showCount={false}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
      {footer ? (
        <div
          className="ml-5 mt-2 inline-flex items-center text-neutral-500"
          role="status"
          aria-live="polite"
          aria-label="Working"
        >
          {footer}
        </div>
      ) : null}
    </>
  )
}

/**
 * The work disclosure's header: a compact surface chip in the same vocabulary as the footer's
 * "Generation details" and Settings sections (Radix trigger, phosphor caret that turns with
 * data-state, ring on keyboard focus), with a state glyph so a folded turn still reads as
 * something to open.
 */
function WorkTrigger({
  state,
  count
}: Readonly<{ state: WorkState; count: number }>): React.JSX.Element {
  const reduceMotion = useReducedMotion()
  const label = STATE_LABELS[state]
  return (
    <CollapsibleTrigger
      aria-label={label}
      className="group inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-card/50 pl-2 pr-1.5 text-[12px] font-medium text-muted-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.03)] transition-[color,background-color,border-color,transform] duration-150 ease-out hover:border-border hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:scale-[0.97] data-[state=open]:border-border data-[state=open]:text-foreground motion-reduce:transition-none motion-reduce:active:scale-100"
    >
      {STATE_GLYPHS[state]}
      {state === 'working' && !reduceMotion ? (
        <TextShimmer as="span" duration={1.8}>
          {label}
        </TextShimmer>
      ) : (
        <span>{label}</span>
      )}
      {count < 2 ? null : (
        // A single step needs no tally. The count is visual; the name stays the state alone.
        <span
          aria-hidden="true"
          className="rounded-sm bg-muted px-1 font-mono text-[10px] leading-4 tabular-nums text-muted-foreground transition-colors group-hover:text-foreground"
        >
          {count}
        </span>
      )}
      <CaretDown
        aria-hidden="true"
        weight="bold"
        className="size-3 shrink-0 opacity-70 transition-[transform,opacity] duration-200 group-hover:opacity-100 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
      />
    </CollapsibleTrigger>
  )
}

/** Opens or closes the task's details beside Chat; the glyph turns with the state. */
function TaskDetailsToggle({
  open,
  onToggle
}: Readonly<{ open: boolean; onToggle: () => void }>): React.JSX.Element {
  const reduceMotion = useReducedMotion()
  const label = open ? 'Close task details' : 'Open task details'
  return (
    // Its own provider: work rows also render outside the app shell's provider.
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon-xs"
            variant="outline"
            aria-label={label}
            onClick={onToggle}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={open ? 'close' : 'open'}
                initial={reduceMotion ? false : { opacity: 0, scale: 0.6, rotate: -45 }}
                animate={{ opacity: 1, scale: 1, rotate: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6, rotate: 45 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                className="flex"
              >
                {open ? <X aria-hidden="true" /> : <SidebarSimple aria-hidden="true" />}
              </motion.span>
            </AnimatePresence>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
