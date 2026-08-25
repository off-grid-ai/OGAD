export interface ActionApprovalRequestView {
  actionType: string
  title: string
  args: Record<string, unknown>
  risk: string
}

export interface ActionApprovalDetail {
  key: string
  label: string
  value: string
  editValue: string
}

export interface ActionApprovalPresentation {
  title: string
  description: string
  details: ActionApprovalDetail[]
  canApprove: boolean
  warning?: string
}

const APPROVAL_CHATTER = new Set([
  'approve',
  'approved',
  'approved please proceed',
  'approve please proceed',
  'please proceed',
  'proceed',
  'go on',
  'continue',
  'do it',
  'yes',
  'yes please',
  'ok',
  'okay'
])

const INTERNAL_ARGUMENTS = new Set([
  'actionId',
  'actionType',
  'kind',
  'payloadHash',
  'risk',
  'source',
  'tool'
])

const LABELS: Record<string, string> = {
  app: 'App',
  description: 'Task',
  destination: 'Save to',
  goal: 'Task',
  inputFolder: 'Source folder',
  instructions: 'Instructions',
  output: 'Save to',
  outputPath: 'Save to',
  prompt: 'Instructions',
  sourceFolder: 'Source folder',
  style: 'Style',
  styleFolder: 'Style folder',
  task: 'Task',
  url: 'Website'
}

function normalizedPhrase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:'"`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isApprovalChatter(value: unknown): boolean {
  return typeof value === 'string' && APPROVAL_CHATTER.has(normalizedPhrase(value))
}

function labelFor(key: string): string {
  if (LABELS[key]) return LABELS[key]
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (letter) => letter.toUpperCase())
}

function displayText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(displayText).filter(Boolean).join(', ')
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !INTERNAL_ARGUMENTS.has(key))
      .map(([key, nested]) => `${labelFor(key)}: ${displayText(nested)}`)
      .filter((line) => !line.endsWith(': '))
      .join('; ')
  }
  return ''
}

function sentence(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, ' ')
  if (!cleaned) return ''
  return cleaned[0]!.toUpperCase() + cleaned.slice(1)
}

export function presentActionApproval(
  request: ActionApprovalRequestView
): ActionApprovalPresentation {
  const titleIsChatter = isApprovalChatter(request.title)
  const details = Object.entries(request.args)
    .filter(([key]) => !INTERNAL_ARGUMENTS.has(key))
    .map(([key, rawValue]): ActionApprovalDetail | null => {
      const value = displayText(rawValue)
      if (!value) return null
      if (isApprovalChatter(rawValue)) {
        return {
          key,
          label: labelFor(key),
          value: 'Add the task you want Off Grid AI to complete.',
          editValue: ''
        }
      }
      return { key, label: labelFor(key), value, editValue: value }
    })
    .filter((detail): detail is ActionApprovalDetail => detail !== null)

  const meaningfulGoal = details.find(
    (detail) => detail.key === 'goal' && detail.editValue.length > 0
  )?.editValue
  const title = !titleIsChatter
    ? sentence(request.title)
    : meaningfulGoal
      ? sentence(meaningfulGoal)
      : 'Review this action'
  const missingTask =
    titleIsChatter &&
    !details.some(
      (detail) =>
        detail.editValue.length > 0 &&
        ['goal', 'task', 'description', 'instructions', 'prompt'].includes(detail.key)
    )

  return {
    title,
    description:
      request.actionType === 'computer_task' || request.actionType === 'computer'
        ? 'Off Grid AI will use the open app to complete this task after you approve.'
        : 'Off Grid AI will complete this task after you approve.',
    details,
    canApprove: !missingTask,
    ...(missingTask ? { warning: 'Add the task details before you approve.' } : {}),
    ...(request.risk === 'irreversible' && !missingTask
      ? { warning: 'This action cannot be undone.' }
      : {})
  }
}
