// Pure builder for the model-facing history of a chat send. Kept Electron-free and
// component-free so it's unit-tested directly — and, more importantly, so the
// history is a function of the messages you PASS it, forcing the caller to pass the
// TARGET conversation's messages.
//
// D8: sendMessage used to build history from `messages` — the ACTIVE tab's slice —
// even for a send bound to a different conversation (a drained queue item, or a
// regen fired while another tab is focused). The model then answered one
// conversation with another's transcript. The fix is to build from the target
// conversation's own messages; this function makes that the only option.

export interface HistoryTurn {
  role: string
  content: string
  context?: { taskGuidance?: unknown } | null
}

/** Build the last `limit` turns of history for a send.
 *  - regen: the latest user turn is already in the thread → keep up to and
 *    including it (drop anything after).
 *  - normal send: append the new user turn.
 *  `convMsgs` MUST be the target conversation's messages. */
export function buildSendHistory<T extends HistoryTurn>(
  convMsgs: readonly T[],
  regen: boolean,
  newUserText: string,
  limit = 20
): HistoryTurn[] {
  // Task guidance is shown in Chat for continuity, but the operator already
  // consumed it. Do not replay it as another user prompt to the resident LLM.
  const flat = convMsgs
    .filter((message) => !message.context?.taskGuidance)
    .map((m) => ({ role: m.role, content: m.content }))
  let base: HistoryTurn[]
  if (regen) {
    const lastUserIdx = flat.map((m) => m.role).lastIndexOf('user')
    base = lastUserIdx >= 0 ? flat.slice(0, lastUserIdx + 1) : flat
  } else {
    base = [...flat, { role: 'user', content: newUserText }]
  }
  return base.slice(-limit)
}
