type ActionsMode = 'todo' | 'approvals'

export type ProNavigationIntent =
  | {
      view: 'actions'
      actionId?: number
      approvalId?: number
      mode?: ActionsMode
      entity?: { id: number; name: string }
    }
  | { view: 'day'; calendarEventId?: number }
  | { view: 'replay'; seekMs?: number }
  | { view: 'meetings'; meetingId?: number }
  | { view: 'chat'; approvalId: number }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

function optionalPositiveInteger(
  value: Record<string, unknown>,
  key: string
): number | null | undefined {
  if (!(key in value)) return undefined
  return isPositiveInteger(value[key]) ? value[key] : null
}

/**
 * Validate navigation data before it mutates shell state. Invalid targets are
 * rejected rather than silently opening an unrelated first record.
 */
export function normalizeProNavigationIntent(value: unknown): ProNavigationIntent | null {
  if (!isRecord(value) || typeof value.view !== 'string') return null

  if (value.view === 'replay') {
    return normalizeReplayIntent(value)
  }

  if (value.view === 'meetings') {
    return normalizeMeetingsIntent(value)
  }

  if (value.view === 'day') {
    const calendarEventId = optionalPositiveInteger(value, 'calendarEventId')
    return calendarEventId === null
      ? null
      : { view: 'day', ...(calendarEventId ? { calendarEventId } : {}) }
  }

  if (value.view === 'chat') {
    const approvalId = optionalPositiveInteger(value, 'approvalId')
    return approvalId ? { view: 'chat', approvalId } : null
  }

  return value.view === 'actions' ? normalizeActionsIntent(value) : null
}

function normalizeReplayIntent(value: Record<string, unknown>): ProNavigationIntent | null {
  const seekMs = optionalPositiveInteger(value, 'seekMs')
  return seekMs === null ? null : { view: 'replay', ...(seekMs ? { seekMs } : {}) }
}

function normalizeMeetingsIntent(value: Record<string, unknown>): ProNavigationIntent | null {
  const meetingId = optionalPositiveInteger(value, 'meetingId')
  return meetingId === null ? null : { view: 'meetings', ...(meetingId ? { meetingId } : {}) }
}

function normalizeActionsIntent(value: Record<string, unknown>): ProNavigationIntent | null {
  const actionId = optionalPositiveInteger(value, 'actionId')
  const approvalId = optionalPositiveInteger(value, 'approvalId')
  if (actionId === null || approvalId === null || (actionId && approvalId)) return null
  if ('mode' in value && value.mode !== 'todo' && value.mode !== 'approvals') return null
  if (actionId && value.mode === 'approvals') return null
  if (approvalId && value.mode === 'todo') return null

  let entity: { id: number; name: string } | undefined
  if ('entity' in value) {
    if (!isRecord(value.entity) || !isPositiveInteger(value.entity.id)) return null
    if (typeof value.entity.name !== 'string' || !value.entity.name.trim()) return null
    entity = { id: value.entity.id, name: value.entity.name.trim() }
  }

  return {
    view: 'actions',
    ...(actionId ? { actionId } : {}),
    ...(approvalId ? { approvalId } : {}),
    ...(value.mode ? { mode: value.mode as ActionsMode } : {}),
    ...(entity ? { entity } : {})
  }
}
