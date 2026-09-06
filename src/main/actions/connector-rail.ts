/**
 * Connector rail adapter for the durable action engine.
 *
 * The engine owns identity, idempotency, state and audit. This adapter owns only
 * validation of the connector payload and one call through the existing connector
 * transport boundary.
 */
import type { ActionRecord, ExecuteResult } from '@offgrid/use'

export interface ConnectorCallResult {
  ok: boolean
  result?: unknown
  error?: string
}

export type CallConnector = (
  connectorId: number,
  tool: string,
  args: Record<string, unknown>
) => Promise<ConnectorCallResult>

export interface ConnectorActionArgs {
  connectorId: number
  tool: string
  args: Record<string, unknown>
}

export function connectorActionArgs(value: Record<string, unknown>): ConnectorActionArgs | null {
  const connectorId = value.connectorId
  const tool = value.tool
  const args = value.args
  if (
    !Number.isSafeInteger(connectorId) ||
    Number(connectorId) <= 0 ||
    typeof tool !== 'string' ||
    !tool.trim() ||
    typeof args !== 'object' ||
    args === null ||
    Array.isArray(args)
  ) {
    return null
  }
  return {
    connectorId: Number(connectorId),
    tool,
    args: args as Record<string, unknown>
  }
}

function resultDetail(value: unknown): string {
  let output: string
  if (typeof value === 'string') output = value
  else if (value === undefined) output = 'Connector action completed.'
  else {
    try {
      output = JSON.stringify(value)
    } catch {
      output = 'Connector action completed.'
    }
  }
  return output.length > 8_000 ? `${output.slice(0, 8_000)}… (truncated)` : output
}

export function makeConnectorRailExecutor(callConnector: CallConnector) {
  return async (action: ActionRecord): Promise<ExecuteResult> => {
    const parsed = connectorActionArgs(action.args)
    if (!parsed) {
      return { ok: false, detail: 'invalid connector action payload' }
    }
    try {
      const result = await callConnector(parsed.connectorId, parsed.tool, parsed.args)
      return result.ok
        ? { ok: true, detail: resultDetail(result.result) }
        : { ok: false, detail: result.error ?? 'connector call failed' }
    } catch (error) {
      return { ok: false, detail: `connector rail failed: ${(error as Error).message}` }
    }
  }
}
