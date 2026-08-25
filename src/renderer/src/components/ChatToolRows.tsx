import type { ChatStreamTool, ProjectedSyncedTool } from '@offgrid/sync'
import { CaretDown, Check, Circle, Warning, Wrench, X } from '@phosphor-icons/react'
import { ChatMarkdown } from './ChatMarkdown'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@renderer/components/ui/collapsible'
import { useTaskSessions } from '@renderer/lib/task-session-store'
import { ComputerUseStepDetails } from './tasks/ComputerUseStepDetails'

type DisplayTool =
  | Pick<ProjectedSyncedTool, 'name' | 'arguments' | 'result' | 'status' | 'durationMs' | 'error'>
  | ChatStreamTool

interface ChatToolRowsProps {
  tools: readonly DisplayTool[] | undefined
}

type WorkStatus = 'running' | 'complete' | 'failed' | 'needs attention'

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
  web_task: 'Web Use',
  web_use: 'Web Use',
  computer_task: 'Computer Use',
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

const TASK_REFERENCE = /(?:^|\s)Task reference:\s*([A-Za-z0-9_-]+)\.?/i

export function taskReferenceFromResult(result: string | undefined): string | undefined {
  return result?.match(TASK_REFERENCE)?.[1]
}

function visibleToolResult(result: string | undefined): string {
  return (result ?? '').replace(TASK_REFERENCE, '').trim()
}

function titleFromIdentifier(name: string): string {
  const clean = normalizedToolKey(name)
    .replace(/[:._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return 'Used tool'
  return clean.charAt(0).toUpperCase() + clean.slice(1)
}

export function workStepLabel(tool: DisplayTool): string {
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

function shortResult(tool: DisplayTool): string {
  const status = workStatus(tool)
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
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('needs attention')) return 'needs attention'
  return 'complete'
}

/** One persisted execution timeline for both live previews and durable assistant turns. */
export function ChatToolRows({ tools }: Readonly<ChatToolRowsProps>): React.JSX.Element | null {
  const { tasks } = useTaskSessions()
  const visible = tools ?? []
  if (visible.length === 0) return null
  const status = overallStatus(visible)

  return (
    <Collapsible
      defaultOpen={status === 'running' || status === 'needs attention'}
      className="mt-1 w-full max-w-[85%] rounded-sm border border-neutral-800 text-neutral-500"
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-2.5 py-2 text-left text-[11px] transition-colors hover:text-neutral-300">
        <Wrench className="h-3.5 w-3.5 shrink-0 text-neutral-600" aria-hidden="true" />
        <span className="min-w-0 flex-1 font-medium text-neutral-300">Work done</span>
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
          {visible.map((tool, index) => {
            const stepStatus = workStatus(tool)
            const result = visibleToolResult(tool.result)
            const error = 'error' in tool ? tool.error?.trim() : undefined
            const details = error || result
            const durationMs = 'durationMs' in tool ? tool.durationMs : undefined
            const taskId = taskReferenceFromResult(tool.result)
            const linkedTask = taskId ? tasks.find((task) => task.taskId === taskId) : undefined
            const hasComputerDetails = Boolean(linkedTask?.stepDetails?.length)
            return (
              <li key={`${tool.name}:${index}`} className="relative pb-2 pl-4 last:pb-0">
                <span className="absolute -left-1.5 top-1 flex h-3 w-3 items-center justify-center bg-neutral-950">
                  {statusIcon(stepStatus)}
                </span>
                <Collapsible>
                  <CollapsibleTrigger
                    disabled={!details && !hasComputerDetails}
                    className="group flex w-full items-start gap-2 text-left disabled:cursor-default"
                    aria-label={`${workStepLabel(tool)}, ${stepStatus}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs text-neutral-300">{workStepLabel(tool)}</span>
                      <span className="mt-0.5 block text-[10px] leading-relaxed text-neutral-500 group-data-[state=open]:hidden">
                        {shortResult(tool)}
                      </span>
                    </span>
                    <span className="shrink-0 text-[9px] text-neutral-600">
                      {durationMs !== undefined ? `${Math.round(durationMs)} ms · ` : ''}
                      {stepStatus}
                    </span>
                    {details || hasComputerDetails ? (
                      <CaretDown
                        className="mt-0.5 h-3 w-3 shrink-0 transition-transform group-data-[state=open]:rotate-180"
                        aria-hidden="true"
                      />
                    ) : null}
                  </CollapsibleTrigger>
                  {details || hasComputerDetails ? (
                    <CollapsibleContent className="mt-1 border-l-2 border-neutral-800 pl-3 text-xs leading-relaxed text-neutral-500">
                      {details ? <ChatMarkdown content={details} /> : null}
                      <ComputerUseStepDetails details={linkedTask?.stepDetails} />
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
