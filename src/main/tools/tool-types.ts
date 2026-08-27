// Leaf types shared by tools.ts and its helpers (the plan executor). They live
// here, not in tools.ts, so a helper can import them without importing the big
// module back - which was a require cycle (tools -> plan-executor -> tools).
export type ToolCall = { name: string; args: Record<string, unknown>; result: string }

// Structured sources surfaced by search_memory so the chat can render them as
// interactive citation cards (thumbnail + open-in-Replay), same as the RAG path.
export type UnifiedSource = {
  key: string
  kind: string
  refId: number
  title: string
  snippet: string
  surface: string
  ts: number
  imagePath: string | null
}
