// A queued chat message and the per-conversation queues. Types only, shared by the queue store,
// its persistence and its drain.

import type { Attachment, ChatMode } from '../components/MemoryChat/types'

export interface QueuedTurn {
  text: string
  atts: Attachment[]
  assistantEnabled?: boolean
  projectId: string | null
  mode: ChatMode
}
export type ChatQueues = Record<string, QueuedTurn[]>
