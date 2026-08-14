/**
 * Read-back verification for the semantic rail (R1 box 14).
 *
 * "Done" must mean the effect is OBSERVABLE, not that the helper returned
 * ok - the field's number-one trust failure is an agent reporting success
 * on a write that never landed. Calendar and reminders can actually be
 * read back (list after create), so their handlers declare read_back and
 * verify here. Messages and mail cannot ("did it send?" has no reliable
 * read-back), so they stay none_fuzzy and single-attempt behind the gate.
 * open_url's launch result IS its verdict.
 *
 * Everything fails closed: a helper error, a malformed result, or missing
 * args verify as false - the retry policy takes it from there.
 */
import type { ActionRecord } from '@offgrid/use'
import type { NativeActionCommand, NativeActionResponse } from './native-helper-logic'

export type RunNative = (cmd: NativeActionCommand) => Promise<NativeActionResponse>

/** Does a helper list result contain an item with this exact title? */
export function listContainsTitle(
  result: unknown,
  key: 'reminders' | 'events',
  title: string
): boolean {
  if (typeof result !== 'object' || result === null) {
    return false
  }
  const items = (result as Record<string, unknown>)[key]
  if (!Array.isArray(items)) {
    return false
  }
  return items.some(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      (item as Record<string, unknown>).title === title
  )
}

const HOUR_MS = 60 * 60 * 1000
const PAD_MS = 60 * 1000

/**
 * The list window for a created event: its own start/end padded by a
 * minute (the helper defaults a missing end to start plus one hour).
 * Undefined when the start is unparseable - nothing sane to verify against.
 */
export function calendarVerifyWindow(args: Record<string, unknown>):
  | { start: string; end: string }
  | undefined {
  const startMs = Date.parse(String(args.start ?? ''))
  if (Number.isNaN(startMs)) {
    return undefined
  }
  const endParsed = Date.parse(String(args.end ?? ''))
  const endMs = Number.isNaN(endParsed) ? startMs + HOUR_MS : endParsed
  return {
    start: new Date(startMs - PAD_MS).toISOString(),
    end: new Date(endMs + PAD_MS).toISOString()
  }
}

/** The read-back verifiers, over the same helper boundary the rail uses. */
export function makeReadBackVerifiers(run: RunNative): {
  reminder: (action: ActionRecord) => Promise<boolean>
  calendar: (action: ActionRecord) => Promise<boolean>
} {
  return {
    async reminder(action) {
      const title = action.args.title
      if (typeof title !== 'string' || title.length === 0) {
        return false
      }
      const res = await run({ command: 'reminders.list', args: {} })
      return res.ok && listContainsTitle(res.result, 'reminders', title)
    },
    async calendar(action) {
      const title = action.args.title
      if (typeof title !== 'string' || title.length === 0) {
        return false
      }
      const window = calendarVerifyWindow(action.args)
      if (!window) {
        return false
      }
      const res = await run({ command: 'calendar.listEvents', args: window })
      return res.ok && listContainsTitle(res.result, 'events', title)
    }
  }
}
