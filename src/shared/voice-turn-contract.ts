/**
 * The voice turn, across the process boundary.
 *
 * `askByVoice` runs in MAIN, because that is where the models, RAG and speech facades are. The turn
 * it delegates to runs in the RENDERER, because that is where desktop's chat session lives - it
 * owns the persisted rows, the retrieval context the transcript discloses, the tool loop, the image
 * hand-off and the variants. Seat C's seam assumed one process; desktop has two, so the executor
 * composed in main is a transport that asks the renderer to run its own turn and waits for the
 * answer.
 *
 * The same inversion the speech playback broker already uses, for the same reason: main owns the
 * decision, the renderer owns the capability.
 */
export const VOICE_TURN_REQUEST_CHANNEL = 'voice-turn:request'
export const VOICE_TURN_RESULT_CHANNEL = 'voice-turn:result'

export interface VoiceTurnHostRequest {
  /** Correlates this turn with the `askByVoice` run and every event it emits. */
  readonly requestId: string
  readonly operationId: string
  readonly conversationId: string
  /** The workflow's turn id. The renderer persists under it, so the run and the rows correlate. */
  readonly turnId: string
  readonly projectId: string | null
  /** The transcribed question, verbatim. It becomes the user message the renderer persists. */
  readonly text: string
}

/** Asked when the run is cancelled or its deadline expires. The renderer ends its own turn. */
export interface VoiceTurnHostCancel {
  readonly requestId: string
}

export type VoiceTurnHostMessage =
  | ({ readonly type: 'run' } & VoiceTurnHostRequest)
  | ({ readonly type: 'cancel' } & VoiceTurnHostCancel)

export type VoiceTurnHostResult =
  /** `answer` is what gets spoken, so it is text a person can hear. */
  | { readonly requestId: string; readonly status: 'completed'; readonly answer: string }
  | { readonly requestId: string; readonly status: 'cancelled' }
  | { readonly requestId: string; readonly status: 'failed'; readonly error: string }
