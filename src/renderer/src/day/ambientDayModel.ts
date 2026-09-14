/**
 * Desktop mirror of the ambient Day domain: the synced types, the two-way reconciliation, and the
 * store<->payload bridge. Kept byte-for-byte equivalent to OGAM's src/services/ambient/{ambientSyncModel,
 * ambientSyncBridge}.ts so both ends converge identically. Consolidate into @offgrid once Piece B fixes
 * the wire shape; duplicated here so the desktop Day view can be built and tested independently.
 *
 * PURE. No React, no store, no transport.
 */

import type { ProactiveActionProposal } from '@offgrid/models'

/** The rendered shape of a captured conversation. A faithful subset of OGAM's TimelineSession. */
export interface AmbientSummary {
  title: string
  headline: string
  decisions: string[]
  actionItems: string[]
  people: string[]
}
export interface TimelineSession {
  id: string
  startMs: number
  endMs: number
  speechMs: number
  summary: AmbientSummary
  summaryStatus: string
  flaggedSegmentIds: string[]
  segments: unknown[]
}

/** When a value last changed, and on which device (tie-breaker). */
export interface SyncStamp {
  at: number
  by: string
}
interface Stamped<T> {
  value: T
  stamp: SyncStamp
}

export interface AmbientSyncPayload {
  sessions: Record<string, Stamped<TimelineSession>>
  done: Record<string, Stamped<boolean>>
  journal: Record<string, Stamped<string>>
  actions: Record<string, Stamped<ProactiveActionProposal[]>>
}

export function isNewer(a: SyncStamp, b: SyncStamp): boolean {
  if (a.at !== b.at) return a.at > b.at
  return a.by > b.by
}

function mergeMap<T>(
  a: Record<string, Stamped<T>>,
  b: Record<string, Stamped<T>>
): Record<string, Stamped<T>> {
  const out: Record<string, Stamped<T>> = { ...a }
  for (const key of Object.keys(b)) {
    const incoming = b[key]
    if (!incoming) continue
    const current = out[key]
    if (!current || isNewer(incoming.stamp, current.stamp)) out[key] = incoming
  }
  return out
}

export function mergeAmbient(a: AmbientSyncPayload, b: AmbientSyncPayload): AmbientSyncPayload {
  return {
    sessions: mergeMap(a.sessions, b.sessions),
    done: mergeMap(a.done, b.done),
    journal: mergeMap(a.journal, b.journal),
    actions: mergeMap(a.actions, b.actions)
  }
}

export interface AmbientStateSlice {
  sessions: TimelineSession[]
  doneTaskIds: string[]
  journalByDay: Record<string, string>
  actionsByDay: Record<string, ProactiveActionProposal[]>
}
export interface AmbientSyncStamps {
  sessions: Record<string, SyncStamp>
  done: Record<string, SyncStamp>
  journal: Record<string, SyncStamp>
  actions: Record<string, SyncStamp>
}
export function emptyStamps(): AmbientSyncStamps {
  return { sessions: {}, done: {}, journal: {}, actions: {} }
}
export function stampNow(localDeviceId: string, atMs: number): SyncStamp {
  return { at: atMs, by: localDeviceId }
}

export interface AmbientProjection extends AmbientStateSlice {}

export function projectAmbient(payload: AmbientSyncPayload): AmbientProjection {
  const sessions = Object.values(payload.sessions)
    .map(e => e.value)
    .sort((x, y) => y.startMs - x.startMs)
  const doneTaskIds = Object.entries(payload.done)
    .filter(([, v]) => v.value)
    .map(([id]) => id)
  const journalByDay: Record<string, string> = {}
  for (const [day, e] of Object.entries(payload.journal)) journalByDay[day] = e.value
  const actionsByDay: Record<string, ProactiveActionProposal[]> = {}
  for (const [day, e] of Object.entries(payload.actions)) actionsByDay[day] = e.value
  return { sessions, doneTaskIds, journalByDay, actionsByDay }
}

export function buildPayload(
  state: AmbientStateSlice,
  stamps: AmbientSyncStamps,
  localDeviceId: string
): AmbientSyncPayload {
  const payload: AmbientSyncPayload = { sessions: {}, done: {}, journal: {}, actions: {} }
  for (const session of state.sessions) {
    payload.sessions[session.id] = {
      value: session,
      stamp: stamps.sessions[session.id] ?? { at: session.startMs, by: localDeviceId }
    }
  }
  const doneSet = new Set(state.doneTaskIds)
  const doneIds = new Set<string>([...Object.keys(stamps.done), ...state.doneTaskIds])
  for (const id of doneIds) {
    payload.done[id] = { value: doneSet.has(id), stamp: stamps.done[id] ?? { at: 0, by: localDeviceId } }
  }
  for (const [day, text] of Object.entries(state.journalByDay)) {
    payload.journal[day] = { value: text, stamp: stamps.journal[day] ?? { at: 0, by: localDeviceId } }
  }
  for (const [day, proposals] of Object.entries(state.actionsByDay)) {
    payload.actions[day] = { value: proposals, stamp: stamps.actions[day] ?? { at: 0, by: localDeviceId } }
  }
  return payload
}

export function stampsOf(payload: AmbientSyncPayload): AmbientSyncStamps {
  const out = emptyStamps()
  for (const [id, e] of Object.entries(payload.sessions)) out.sessions[id] = e.stamp
  for (const [id, e] of Object.entries(payload.done)) out.done[id] = e.stamp
  for (const [day, e] of Object.entries(payload.journal)) out.journal[day] = e.stamp
  for (const [day, e] of Object.entries(payload.actions)) out.actions[day] = e.stamp
  return out
}

export interface AppliedAmbient {
  state: AmbientStateSlice
  stamps: AmbientSyncStamps
}
export function applyRemote(
  state: AmbientStateSlice,
  stamps: AmbientSyncStamps,
  remote: AmbientSyncPayload,
  localDeviceId: string
): AppliedAmbient {
  const local = buildPayload(state, stamps, localDeviceId)
  const merged = mergeAmbient(local, remote)
  return { state: projectAmbient(merged), stamps: stampsOf(merged) }
}
