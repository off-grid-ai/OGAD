import { useSyncExternalStore } from 'react'
import type { DesktopSpeechSnapshot } from '../../../shared/speech-command-contract'

export interface SpeechProjectionFailure {
  readonly kind: 'transport'
  readonly message: string
}

export type SpeechProjection =
  | { readonly status: 'loading'; readonly snapshot: null; readonly failure: null }
  | { readonly status: 'ready'; readonly snapshot: DesktopSpeechSnapshot; readonly failure: null }
  | {
      readonly status: 'failed'
      readonly snapshot: DesktopSpeechSnapshot | null
      readonly failure: SpeechProjectionFailure
    }

const listeners = new Set<() => void>()
let projection: SpeechProjection = { status: 'loading', snapshot: null, failure: null }
let disconnect: (() => void) | null = null
let connection = 0
let publication = 0

function publish(next: SpeechProjection): void {
  projection = next
  listeners.forEach((listener) => listener())
}

function transportFailure(cause: unknown): SpeechProjectionFailure {
  return {
    kind: 'transport',
    message:
      cause instanceof Error && cause.message ? cause.message : 'Speech state is unavailable.'
  }
}

function connect(): void {
  const activeConnection = ++connection
  const publicationBeforeRead = publication

  try {
    disconnect = window.api.speechCommands.onSnapshot((snapshot) => {
      if (activeConnection !== connection) return
      publication += 1
      publish({ status: 'ready', snapshot, failure: null })
    })
  } catch (cause) {
    publish({ status: 'failed', snapshot: projection.snapshot, failure: transportFailure(cause) })
    return
  }

  const readFailed = (cause: unknown): void => {
    if (activeConnection === connection && publication === publicationBeforeRead) {
      publish({ status: 'failed', snapshot: projection.snapshot, failure: transportFailure(cause) })
    }
  }

  // The first read can fail before it starts or while it runs. Starting the read
  // inside the chain turns an immediate throw into a rejection, so both paths end
  // in ONE place: dictation says it failed instead of going quiet.
  void Promise.resolve()
    .then(() => window.api.speechCommands.getSnapshot())
    .then((snapshot) => {
      if (activeConnection === connection && publication === publicationBeforeRead) {
        publish({ status: 'ready', snapshot, failure: null })
      }
    })
    .catch(readFailed)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) connect()

  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    connection += 1
    disconnect?.()
    disconnect = null
  }
}

function getProjection(): SpeechProjection {
  return projection
}

/** Read the Shared speech lifecycle through one race-safe reactive Desktop projection. */
export function useSpeechProjection(): SpeechProjection {
  return useSyncExternalStore(subscribe, getProjection, getProjection)
}
