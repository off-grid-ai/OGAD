// What the assistant is doing right now, announced to anything in the window that wants to show it
// (for example an on-screen companion). Core only announces; it knows nothing about who listens.

export type AssistantActivity = 'working' | 'acting' | 'done' | 'idle'

const ACTIVITY = 'offgrid:assistant-activity'
const LISTENING = 'offgrid:assistant-listening'

export function announceAssistantActivity(activity: AssistantActivity): void {
  window.dispatchEvent(new CustomEvent<AssistantActivity>(ACTIVITY, { detail: activity }))
}

export function announceAssistantListening(listening: boolean): void {
  window.dispatchEvent(new CustomEvent<boolean>(LISTENING, { detail: listening }))
}

export function onAssistantActivity(callback: (activity: AssistantActivity) => void): () => void {
  const listener = (event: Event): void =>
    callback((event as CustomEvent<AssistantActivity>).detail)
  window.addEventListener(ACTIVITY, listener)
  return () => window.removeEventListener(ACTIVITY, listener)
}

export function onAssistantListening(callback: (listening: boolean) => void): () => void {
  const listener = (event: Event): void => callback((event as CustomEvent<boolean>).detail)
  window.addEventListener(LISTENING, listener)
  return () => window.removeEventListener(LISTENING, listener)
}
