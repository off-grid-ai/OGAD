import { operationWins, type Op } from '@offgrid/sync'
import type Database from 'better-sqlite3-multiple-ciphers'

type OpRow = {
  op_id: string
  kind: string
  lamport: number
  device_id: string
  ts: number
}

export function isPersistedWinningOperation(input: {
  db: Database.Database
  entity: string
  entityId: string
  operationId: string
}): boolean {
  return persistedWinningOperationStatus(input) === 'current'
}

export function persistedWinningOperationStatus(input: {
  db: Database.Database
  entity: string
  entityId: string
  operationId: string
}): 'current' | 'superseded' | 'not_ready' {
  const { db, entity, entityId, operationId } = input
  let rows: OpRow[]
  try {
    rows = db
      .prepare(
        `SELECT op_id, kind, lamport, device_id, ts FROM sync_ops
         WHERE entity = ? AND entity_id = ?`
      )
      .all(entity, entityId) as OpRow[]
  } catch (cause) {
    throw new Error('Remote deletion winner history is unavailable.', { cause })
  }
  let winner: Op | undefined
  for (const row of rows) {
    if (row.kind !== 'put' && row.kind !== 'delete') {
      throw new Error(`Sync operation ${row.op_id} has an invalid kind.`)
    }
    const operation: Op = {
      opId: row.op_id,
      entity,
      entityId,
      kind: row.kind,
      lamport: row.lamport,
      deviceId: row.device_id,
      ts: row.ts
    }
    if (!winner || operationWins(operation, winner)) winner = operation
  }
  if (!winner) return 'not_ready'
  return winner.opId === operationId ? 'current' : 'superseded'
}
