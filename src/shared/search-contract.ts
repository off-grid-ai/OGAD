/** `message`: a synced email or chat (from a connected account), not something seen on screen.
 *  The retired legacy stores' kinds ('memory', 'fact') are no longer searched; a saved result may
 *  still carry one (see search-navigation). */
export type SearchKind =
  | 'screen'
  | 'message'
  /** A to-do or commitment (action item). */
  | 'action'
  | 'meeting'
  | 'entity'
  /** A legacy chat-session summary. */
  | 'summary'
  | 'chat'
  | 'doc'
  /** A passage of a document attached to the chat (key: attachment:<documentId>:<page>:<position>). */
  | 'attachment'

export type SearchSort = 'relevance' | 'recency' | 'match'

/** Stable universal-search result shared by main, preload, and renderer. */
export interface SearchResult {
  key: string
  kind: SearchKind
  refId: number
  title: string
  snippet: string
  surface: string
  url: string | null
  ts: number
  imagePath: string | null
  score: number
}
