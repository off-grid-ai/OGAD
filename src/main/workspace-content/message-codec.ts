import { parseMessageOrderToken, type MessageRecord } from '@offgrid/application'

export type DesktopWorkspaceMessageRow = {
  id: string
  conversation_id: string
  turn_id: string | null
  position: number
  role: MessageRecord['portable']['role']
  content: string | null
  content_json: string | null
  context_json: string | null
  legacy_order_created_at: string | null
  order_token_json: string | null
  state_json: string | null
  created_at: string
  updated_at: string
}

const parseJson = <T>(value: string): T => JSON.parse(value) as T

export function desktopWorkspaceMessageFromRow(row: DesktopWorkspaceMessageRow): MessageRecord {
  const context = row.context_json
    ? parseJson<MessageRecord['portable']['context']>(row.context_json)
    : undefined
  const local = row.state_json ? parseJson<MessageRecord['local']>(row.state_json) : undefined
  const content = row.content_json
    ? parseJson<Extract<MessageRecord['portable']['content'], readonly unknown[]>>(row.content_json)
    : row.content
  if (content === null) throw new Error(`Workspace message ${row.id} has no content`)
  const orderToken = row.order_token_json
    ? parseMessageOrderToken(JSON.parse(row.order_token_json) as unknown)
    : null
  if (row.order_token_json && !orderToken)
    throw new Error(`Workspace message ${row.id} has an invalid order token`)
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    position: row.position,
    ...(orderToken ? { orderToken } : {}),
    portable: { role: row.role, content, ...(context ? { context } : {}) },
    ...(row.legacy_order_created_at
      ? { legacyOrder: { source: 'positionless_sync', createdAt: row.legacy_order_created_at } }
      : {}),
    ...(local ? { local } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
