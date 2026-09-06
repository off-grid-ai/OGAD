import {
  toolWorkStatus,
  type ChatStreamTool,
  type ProjectedSyncedTool,
  type ToolWorkStatus
} from '@offgrid/application'
import { CaretDown, Check, Circle, Warning, Wrench, X } from '@phosphor-icons/react'
import { ChatMarkdown } from './ChatMarkdown'
import { ChatThinkingBlock } from './ChatThinkingBlock'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@renderer/components/ui/collapsible'
import { type TaskSession, useTaskSessions } from '@renderer/lib/task-session-store'
import {
  closeTaskWorkspace,
  openTaskSidePanel,
  useTaskWorkspaceOpen
} from '@renderer/lib/task-side-panel'
import { ComputerUseStepDetails } from './tasks/ComputerUseStepDetails'
import { RetryTaskButton } from './tasks/RetryTaskButton'
import { taskReferenceFromResult, visibleToolResult } from './chat-tool-projection'
import { ContextDetails } from './ChatMessageContext'
import { contextResultCount, type ContextNavigation } from './chat-message-projection'
import type { RagContext } from '@renderer/lib/chat-transcript-types'

type DisplayTool = (
  | Pick<ProjectedSyncedTool, 'name' | 'arguments' | 'result' | 'status' | 'durationMs' | 'error'>
  | ChatStreamTool
) & {
  /** The model's thought process right before this step, when the transcript kept it. */
  reasoning?: string
}

interface ChatToolRowsProps {
  tools?: readonly DisplayTool[]
  /** The task that belongs to this live Chat turn before its tool result contains a task id. */
  liveTask?: TaskSession
  /** Retrieved evidence belongs to the search step that produced it. */
  context?: RagContext
  navigation?: ContextNavigation
}

type WorkStatus = ToolWorkStatus

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

function isMemorySearch(tool: DisplayTool): boolean {
  const key = normalizedToolKey(tool.name)
  return key === 'search_memory' || key === 'search_meetings'
}

function workStepLabel(tool: DisplayTool, memoryResultCount = 0): string {
  const key = normalizedToolKey(tool.name)
  if (key === 'proposal_deck') {
    const action = String(
      parseArguments('arguments' in tool ? tool.arguments : undefined)?.action ?? ''
    )
    return PROPOSAL_STAGE_LABELS[action] ?? 'Updated proposal deck'
  }
  if (isMemorySearch(tool) && memoryResultCount > 0) {
    return `Searched your memory — ${memoryResultCount} result${memoryResultCount === 1 ? '' : 's'}`
  }
  return TOOL_LABELS[key] ?? titleFromIdentifier(key)
}

/** Project this row's shape onto the one shared rule for what a tool call's status means. */
function workStatus(tool: DisplayTool): WorkStatus {
  return toolWorkStatus({
    name: normalizedToolKey(tool.name),
    status: tool.status,
    result: visibleToolResult(tool.result),
    error: 'error' in tool ? tool.error : undefined
  })
}

function shortResult(tool: DisplayTool, status = workStatus(tool), taskSummary?: string): string {
  if (taskSummary?.trim()) return taskSummary.trim()
  if (status === 'running') return 'In progress.'
  if (status === 'cancelled') return 'Cancelled.'
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
  if (key === 'search_meetings') {
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

function statusIcon(status: WorkStatus): React.JSX.Element {
  if (status === 'complete') {
    return <Check className="h-3 w-3 text-green-500" aria-hidden="true" />
  }
  if (status === 'failed') return <X className="h-3 w-3 text-red-500" aria-hidden="true" />
  if (status === 'cancelled') {
    return <X className="h-3 w-3 text-neutral-500" aria-hidden="true" />
  }
  if (status === 'needs attention') {
    return <Warning className="h-3 w-3 text-amber-500" aria-hidden="true" />
  }
  return (
    <Circle weight="fill" className="h-2.5 w-2.5 animate-pulse text-green-500" aria-hidden="true" />
  )
}

function overallStatus(tools: readonly DisplayTool[]): WorkStatus {
  const statuses = tools.map(workStatus)
  if (statuses.includes('running')) return 'running'
  // You stopped it: that is the outcome, whatever a step before it returned.
  if (statuses.includes('cancelled')) return 'cancelled'
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('needs attention')) return 'needs attention'
  return 'complete'
}

function taskWorkStatus(task: TaskSession | undefined): WorkStatus | undefined {
  if (!task) return undefined
  if (task.status === 'failed') return 'failed'
  // You stopped it. That is not a failure, and the card must not say it is.
  if (task.status === 'stopped') return 'cancelled'
  if (task.status === 'paused' || task.status === 'waiting') return 'needs attention'
  if (task.status === 'running' || task.status === 'reconnecting') return 'running'
  return 'complete'
}

function workHeading(status: WorkStatus): string {
  if (status === 'running') return 'Working'
  if (status === 'needs attention') return 'Action needed'
  if (status === 'failed') return 'Work failed'
  if (status === 'cancelled') return 'Work stopped'
  return 'Work done'
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
  liveTask,
  context,
  navigation
}: Readonly<ChatToolRowsProps>): React.JSX.Element | null {
  const { tasks } = useTaskSessions()
  const taskWorkspaceOpen = useTaskWorkspaceOpen()
  // Web Use can start before toolChat returns its durable tool result. Project one
  // pending row from the live task so the chat reports work at the time it happens.
  // Once the real tool call arrives, it replaces this transient projection.
  const visible: readonly DisplayTool[] =
    tools?.length || !liveTask
      ? (tools ?? [])
      : [
          {
            name: liveTask.kind === 'web_use' ? 'web_use' : 'computer_use',
            arguments: '{}',
            result: '',
            status: 'running'
          }
        ]
  if (visible.length === 0) return null
  const liveToolIndex = liveTaskToolIndex(visible, liveTask)
  const projected = visible.map((tool, index) => {
    const taskId = taskReferenceFromResult(tool.result)
    const linkedTask =
      linkedTaskForReference(tasks, taskId) ?? (index === liveToolIndex ? liveTask : undefined)
    return { tool, taskId, linkedTask, status: taskWorkStatus(linkedTask) ?? workStatus(tool) }
  })
  const memoryResultCount = context ? contextResultCount(context) : 0
  const contextStepIndex = projected.findIndex(({ tool }) => isMemorySearch(tool))
  const projectedStatuses = projected.map((item) => item.status)
  const status = projectedStatuses.includes('running')
    ? 'running'
    : projectedStatuses.includes('cancelled')
      ? 'cancelled'
      : projectedStatuses.includes('failed')
        ? 'failed'
        : projectedStatuses.includes('needs attention')
          ? 'needs attention'
          : overallStatus(visible)

  return (
    <Collapsible
      defaultOpen={status === 'running' || status === 'needs attention'}
      className="mt-1 w-full max-w-[85%] rounded-sm border border-neutral-800 text-neutral-500"
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-2.5 py-2 text-left text-[11px] transition-colors hover:text-neutral-300">
        <Wrench className="h-3.5 w-3.5 shrink-0 text-neutral-600" aria-hidden="true" />
        <span className="min-w-0 flex-1 font-medium text-neutral-300">{workHeading(status)}</span>
        <span className="text-[10px] text-neutral-600">
          {visible.length} {visible.length === 1 ? 'step' : 'steps'} · {status}
        </span>
        <CaretDown
          className="h-3 w-3 shrink-0 transition-transform group-data-[state=open]:rotate-180"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-neutral-800 px-2.5 py-2">
        <ol className="ml-1 border-l border-neutral-800">
          {projected.map(({ tool, linkedTask, status: stepStatus }, index) => {
            const result = visibleToolResult(tool.result)
            const error = 'error' in tool ? tool.error?.trim() : undefined
            const taskSummary = linkedTask?.summary?.trim()
            const liveTaskLine =
              stepStatus === 'running' ? linkedTask?.currentAction?.trim() : undefined
            const rowSummary = liveTaskLine || taskSummary
            const details = taskSummary || error || result
            const durationMs = 'durationMs' in tool ? tool.durationMs : undefined
            const hasComputerDetails = Boolean(linkedTask?.stepDetails?.length)
            const reasoning = tool.reasoning?.trim()
            const ownsContext =
              index === contextStepIndex &&
              memoryResultCount > 0 &&
              context !== undefined &&
              navigation !== undefined
            const hasDisclosure =
              Boolean(details) ||
              hasComputerDetails ||
              Boolean(linkedTask) ||
              Boolean(reasoning) ||
              Boolean(ownsContext)
            return (
              <li key={`${tool.name}:${index}`} className="relative pb-2 pl-4 last:pb-0">
                <span className="absolute -left-1.5 top-1 flex h-3 w-3 items-center justify-center bg-neutral-950">
                  {statusIcon(stepStatus)}
                </span>
                <Collapsible>
                  <CollapsibleTrigger
                    disabled={!hasDisclosure}
                    className="group flex w-full items-start gap-2 text-left disabled:cursor-default"
                    aria-label={`${workStepLabel(tool, memoryResultCount)}, ${stepStatus}`}
                    onClick={() => {
                      if (linkedTask) {
                        openTaskSidePanel({
                          taskId: linkedTask.taskId,
                          kind: linkedTask.kind,
                          detail: true
                        })
                      }
                    }}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs text-neutral-300">
                        {workStepLabel(tool, memoryResultCount)}
                      </span>
                      <span className="mt-0.5 block text-[10px] leading-relaxed text-neutral-500 group-data-[state=open]:hidden">
                        {shortResult(tool, stepStatus, rowSummary)}
                      </span>
                    </span>
                    <span className="shrink-0 text-[9px] text-neutral-600">
                      {durationMs !== undefined ? `${Math.round(durationMs)} ms · ` : ''}
                      {stepStatus}
                    </span>
                    {hasDisclosure ? (
                      <CaretDown
                        className="mt-0.5 h-3 w-3 shrink-0 transition-transform group-data-[state=open]:rotate-180"
                        aria-hidden="true"
                      />
                    ) : null}
                  </CollapsibleTrigger>
                  {hasDisclosure ? (
                    <CollapsibleContent className="mt-1 border-l-2 border-neutral-800 pl-3 text-xs leading-relaxed text-neutral-500">
                      {reasoning ? (
                        <ChatThinkingBlock content={reasoning} className="mb-1.5" />
                      ) : null}
                      {details ? <ChatMarkdown content={details} /> : null}
                      {ownsContext ? (
                        <div className="mt-2 max-h-[400px] overflow-y-auto border-t border-neutral-800 pt-2">
                          <ContextDetails context={context} navigation={navigation} />
                        </div>
                      ) : null}
                      <ComputerUseStepDetails details={linkedTask?.stepDetails} />
                      {linkedTask ? (
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="mt-2 border border-neutral-700 px-2 py-1 text-[10px] text-neutral-300 hover:border-neutral-500"
                            onClick={() =>
                              taskWorkspaceOpen
                                ? closeTaskWorkspace()
                                : openTaskSidePanel({
                                    taskId: linkedTask.taskId,
                                    kind: linkedTask.kind,
                                    detail: true
                                  })
                            }
                          >
                            {taskWorkspaceOpen ? 'Close task details' : 'Open task details'}
                          </button>
                          <RetryTaskButton task={linkedTask} />
                        </div>
                      ) : null}
                    </CollapsibleContent>
                  ) : null}
                </Collapsible>
              </li>
            )
          })}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  )
}
