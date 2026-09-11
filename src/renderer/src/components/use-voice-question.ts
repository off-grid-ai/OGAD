/**
 * One voice question, from the captured audio to the spoken answer.
 *
 * `workflows.askByVoice` owns the sequence: transcribe, build the turn, speak the answer, under one
 * correlated operation id with one deadline and one cancel. It runs in MAIN, where the models, RAG
 * and speech facades are. This hook is the app's two halves of that conversation - it hands over
 * the audio and holds the run's id, and it answers when main asks this window to run the turn,
 * because the chat session that owns persisted rows, retrieval context, tools and variants lives
 * here.
 *
 * What it replaces, in the chat root: a transcription call with its own operation id and cancel, a
 * judgement about whether the transcript was worth sending, and six separate places that armed an
 * auto-speak for the answer. None of that is here, because none of it is this app's decision any
 * more.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { workflowFailureMessage } from '@offgrid/application'
import type { ChatVoiceClip } from './use-chat-voice-turns'

export interface VoiceTurnAssignment {
  /** Shared's authoritative identity for this workflow turn. */
  readonly turnId: string
  readonly conversationId: string
  readonly projectId: string | null
  readonly text: string
  /** The recording, so the user's turn keeps the audio they actually spoke. */
  readonly clip: ChatVoiceClip | null
}

export interface VoiceQuestionOptions {
  /** In voice mode the answer becomes a chat turn; outside it the words go into the composer. */
  readonly voiceMode: boolean
  readonly conversationId: string | null
  readonly projectId: string | null
  /** Speak the answer back. */
  readonly speak: boolean
  readonly onTranscriptForDraft: (text: string) => void
  /** Run the turn this question earned, and report the answer it settled on. */
  readonly runTurn: (
    request: VoiceTurnAssignment,
    onAnswer: (answer: string) => void
  ) => Promise<void>
  /** End the turn we own, the same way the Stop button does. */
  readonly stopTurn: (conversationId: string) => void
}

export interface VoiceQuestion {
  capture: (audio: Uint8Array, mimeType: string, clip: ChatVoiceClip | null) => void
  /** The user discarded the capture, or stopped the answer. */
  abandon: () => void
  /** What the run reported, in the user's words. Null when it has nothing to say. */
  error: string | null
  /** Shared reports that this correlated answer is being spoken. */
  speaking: boolean
}

export function useVoiceQuestion(options: VoiceQuestionOptions): VoiceQuestion {
  const [error, setError] = useState<string | null>(null)
  const [speaking, setSpeaking] = useState(false)
  const runRef = useRef<string | null>(null)
  const clipRef = useRef<ChatVoiceClip | null>(null)
  const hostTurnConversationsRef = useRef(new Map<string, string>())
  // Held by reference so the two subscriptions below register ONCE: they are rebuilt every render,
  // and a listener that re-registers per render is a listener that can miss the event it exists
  // for.
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  }, [options])

  const capture = useCallback(
    (audio: Uint8Array, mimeType: string, clip: ChatVoiceClip | null): void => {
      const { voiceMode, conversationId, projectId, speak } = optionsRef.current
      clipRef.current = clip
      setError(null)
      // A question dictated into the composer is not a turn: with no conversation the workflow
      // answers directly and there is nothing to persist, which is why `conversationId` only rides
      // along in voice mode.
      void window.api.askByVoice
        .start({
          bytes: audio,
          mimeType,
          ...(voiceMode && conversationId ? { conversationId } : {}),
          projectId,
          speak: voiceMode && speak
        })
        .then(({ operationId }) => {
          runRef.current = operationId
        })
        .catch((cause: unknown) => {
          console.error('[voice] the voice question could not be started', cause)
          setError('The voice question could not be started. Try again.')
        })
    },
    []
  )

  const abandon = useCallback((): void => {
    const operationId = runRef.current
    if (!operationId) return
    runRef.current = null
    // The workflow is the one canceller: it aborts the run, and for a turn this side is executing
    // the run's signal IS the stop. Issuing a second teardown for the same turn is how a turn gets
    // half-torn-down twice.
    void window.api.askByVoice.cancel(operationId).catch((cause: unknown) => {
      console.error('[voice] the voice question could not be cancelled', cause)
    })
  }, [])

  /** What the run reports, rendered - not re-derived. */
  useEffect(() => {
    return window.api.askByVoice.onEvent(({ operationId, event }) => {
      if (runRef.current && operationId !== runRef.current) return
      if (event.type === 'transcribed') {
        const text = event.text.trim()
        // Outside voice mode the words ARE the product: they go into the composer, and no turn is
        // run for them.
        if (!optionsRef.current.voiceMode && text) optionsRef.current.onTranscriptForDraft(text)
        return
      }
      if (event.type === 'failed') {
        runRef.current = null
        setSpeaking(false)
        // "Didn't catch that" and every transcription, model or playback failure arrive here, in
        // the words of the domain that failed.
        setError(workflowFailureMessage(event.failure))
        return
      }
      if (event.type === 'speaking') setSpeaking(true)
      if (event.type === 'cancelled') {
        runRef.current = null
        setSpeaking(false)
      }
      if (event.type === 'completed') {
        runRef.current = null
        setSpeaking(false)
        setError(null)
      }
    })
  }, [])

  /**
   * The turn a voice question earned, run by the session that owns turns.
   *
   * The workflow does not compensate if this fails midway, deliberately: the rows written are this
   * side's to keep, and a second opinion from shared could delete a turn the user can see. So the
   * result reported here is exactly what happened, including a failure.
   */
  useEffect(() => {
    return window.api.voiceTurn.onRequest((message) => {
      if (message.type === 'cancel') {
        const conversationId = hostTurnConversationsRef.current.get(message.requestId)
        if (conversationId) optionsRef.current.stopTurn(conversationId)
        return
      }
      hostTurnConversationsRef.current.set(message.requestId, message.conversationId)
      let answer = ''
      const clip = clipRef.current
      clipRef.current = null
      void optionsRef.current
        .runTurn(
          {
            turnId: message.turnId,
            conversationId: message.conversationId,
            projectId: message.projectId,
            text: message.text,
            clip
          },
          (settled) => {
            answer = settled
          }
        )
        .then(() => {
          hostTurnConversationsRef.current.delete(message.requestId)
          window.api.voiceTurn.respond({
            requestId: message.requestId,
            status: 'completed',
            answer
          })
        })
        .catch((cause: unknown) => {
          hostTurnConversationsRef.current.delete(message.requestId)
          window.api.voiceTurn.respond({
            requestId: message.requestId,
            status: 'failed',
            error: cause instanceof Error ? cause.message : String(cause)
          })
        })
    })
  }, [])

  return { capture, abandon, error, speaking }
}
