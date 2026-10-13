/** Capture before any await: a replacement run must never receive an old cancel. */
export function targetRun(
  streams: ReadonlyMap<string, string>,
  conversationId: string
): string | undefined {
  const ids = [...streams].filter(([, cid]) => cid === conversationId).map(([id]) => id)
  return ids.find((id) => id.startsWith('send-') || id.startsWith('prepare-')) ?? ids[0]
}
export function matchesRunCancel(target: string | undefined, runId: string): boolean {
  return target === runId
}
export function unownedTerminal(type: string, owned: boolean): boolean {
  return !owned && ['done', 'error', 'cancel', 'cancelled'].includes(type)
}

/** Persistence completes before releasing busy and draining a restored queue. */
export async function settleUnownedStream(
  persist: () => Promise<void>,
  release: () => void,
  drain: () => void
): Promise<void> {
  await persist()
  release()
  drain()
}

export interface RunStopTarget {
  runId?: string
  streamId?: string
}
export function captureStopTarget(
  streams: ReadonlyMap<string, string>,
  messages: readonly { id: string; streaming?: boolean }[],
  cid: string
): RunStopTarget {
  const runId = targetRun(streams, cid)
  return {
    runId,
    streamId:
      messages.find((message) => message.streaming)?.id ??
      (runId && !runId.startsWith('send-') && !runId.startsWith('prepare-') ? runId : undefined)
  }
}

export function preparingRunIds(streams: ReadonlyMap<string, string>, cid: string): string[] {
  return [...streams]
    .filter(([id, owner]) => owner === cid && id.startsWith('prepare-'))
    .map(([id]) => id)
}
