/** Portable chat identity supplied by an authenticated Off Grid AI MCP client. */
export interface McpTaskOrigin {
  conversationId: string
  deviceId?: string
  deviceName?: string
}

export const OFFGRID_TASK_ORIGIN_META_KEY = 'ai.offgrid/taskOrigin'

const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

function boundedPortableId(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= maxLength && PORTABLE_ID.test(normalized)
    ? normalized
    : undefined
}

function boundedLabel(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : undefined
}

/**
 * Read the chat owner from MCP request metadata.
 *
 * The HTTP action-token gate authenticates the caller before this parser is reached. This parser
 * still fails closed because the value becomes a durable chat and task identity on this Desktop.
 */
export function parseMcpTaskOrigin(meta: unknown): McpTaskOrigin | undefined {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const envelope = (meta as Record<string, unknown>)[OFFGRID_TASK_ORIGIN_META_KEY]
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return undefined
  const value = envelope as Record<string, unknown>
  const conversationId = boundedPortableId(value.conversationId, 160)
  if (!conversationId) return undefined
  const deviceId = boundedPortableId(value.deviceId, 160)
  const deviceName = boundedLabel(value.deviceName, 120)
  return {
    conversationId,
    ...(deviceId ? { deviceId } : {}),
    ...(deviceName ? { deviceName } : {})
  }
}
