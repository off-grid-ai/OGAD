/**
 * Desktop ambient Day store — the mirror the synced payload materializes into, and the source the Day
 * screen renders. Same read/write contract as OGAM's ambientTimelineStore (toSyncPayload /
 * applySyncPayload / toggleTask / resolveDayAction), so write-back rides the exact reconciliation the
 * phone uses. A plain useSyncExternalStore singleton — the house pattern on desktop (no zustand).
 *
 * Not wired to the transport yet (Piece B). setDeviceId + applySyncPayload are the seams the sync
 * adapter calls; until then the screen runs against whatever is applied locally.
 */

import { useSyncExternalStore } from 'react'
import type { ProactiveActionProposal } from '@offgrid/models'
import {
  applyRemote,
  buildPayload,
  emptyStamps,
  stampNow,
  type AmbientStateSlice,
  type AmbientSyncStamps,
  type AmbientSyncPayload,
  type TimelineSession
} from './ambientDayModel'

interface DayState extends AmbientStateSlice {
  stamps: AmbientSyncStamps
}

let state: DayState = {
  sessions: [],
  doneTaskIds: [],
  journalByDay: {},
  actionsByDay: {},
  stamps: emptyStamps()
}
let deviceId = 'desktop-local'
const listeners = new Set<() => void>()

function emit(next: DayState): void {
  state = next
  listeners.forEach(l => l())
}

/** The sync identity to stamp desktop-side writes with. Set once the sync layer knows it. */
export function setDayDeviceId(id: string): void {
  deviceId = id || 'desktop-local'
}

export function subscribeDay(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function getDaySnapshot(): DayState {
  return state
}

/** Toggle a day-task done state (write-back path). */
export function toggleTask(id: string): void {
  const doneTaskIds = state.doneTaskIds.includes(id)
    ? state.doneTaskIds.filter(x => x !== id)
    : [...state.doneTaskIds, id]
  emit({
    ...state,
    doneTaskIds,
    stamps: { ...state.stamps, done: { ...state.stamps.done, [id]: stampNow(deviceId, Date.now()) } }
  })
}

/** Dismiss/approve a proposed action for a day (removes it, stamps the day). */
export function resolveDayAction(dayKey: string, index: number): void {
  emit({
    ...state,
    actionsByDay: {
      ...state.actionsByDay,
      [dayKey]: (state.actionsByDay[dayKey] ?? []).filter((_, i) => i !== index)
    },
    stamps: { ...state.stamps, actions: { ...state.stamps.actions, [dayKey]: stampNow(deviceId, Date.now()) } }
  })
}

/** Serialize the synced slice for the sync adapter to push. */
export function toSyncPayload(): AmbientSyncPayload {
  return buildPayload(state, state.stamps, deviceId)
}

/** Merge an inbound payload from another device into local state. */
export function applySyncPayload(remote: AmbientSyncPayload): void {
  const applied = applyRemote(state, state.stamps, remote, deviceId)
  emit({ ...applied.state, stamps: applied.stamps })
}

// ── derivations for the view ─────────────────────────────────────────

export interface DayTask {
  id: string
  text: string
  sessionId: string
  done: boolean
}

export function dayKeyOf(epochMs: number): string {
  const d = new Date(epochMs)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** Day keys that have sessions, newest first. */
export function dayKeysWithSessions(sessions: TimelineSession[]): string[] {
  const keys = new Set(sessions.map(s => dayKeyOf(s.startMs)))
  return [...keys].sort((a, b) => (a < b ? 1 : -1))
}
export function sessionsForDay(sessions: TimelineSession[], dayKey: string): TimelineSession[] {
  return sessions.filter(s => dayKeyOf(s.startMs) === dayKey).sort((a, b) => b.startMs - a.startMs)
}
export function tasksForDay(
  sessions: TimelineSession[],
  doneTaskIds: string[],
  dayKey: string
): DayTask[] {
  const done = new Set(doneTaskIds)
  const tasks: DayTask[] = []
  for (const s of sessionsForDay(sessions, dayKey)) {
    s.summary.actionItems.forEach((text, i) => {
      const id = `${s.id}#${i}`
      tasks.push({ id, text, sessionId: s.id, done: done.has(id) })
    })
  }
  return tasks
}
export function actionsForDay(
  actionsByDay: Record<string, ProactiveActionProposal[]>,
  dayKey: string
): ProactiveActionProposal[] {
  return actionsByDay[dayKey] ?? []
}

/** React hook: subscribe to the whole Day store. */
export function useDay(): DayState {
  return useSyncExternalStore(subscribeDay, getDaySnapshot)
}
