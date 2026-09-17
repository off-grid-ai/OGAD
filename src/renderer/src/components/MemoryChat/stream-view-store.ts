import { useCallback, useSyncExternalStore } from 'react'
import { applyStreamEvent, type StreamEvent } from '@renderer/lib/stream-reducer'
import type { ChatMessage } from './types'

const streamMessages = new Map<string, ChatMessage>()
const streamListeners = new Map<string, Set<() => void>>()

function notifyStream(streamId: string): void {
  for (const listener of streamListeners.get(streamId) ?? []) listener()
}

export function seedStreamViewMessage(message: ChatMessage): void {
  streamMessages.set(message.id, message)
  notifyStream(message.id)
}

export function applyStreamViewEvent(streamId: string, event: StreamEvent): void {
  const current = streamMessages.get(streamId)
  if (!current) return
  streamMessages.set(streamId, applyStreamEvent(current, event) as ChatMessage)
  notifyStream(streamId)
}

export function resetStreamViewMessage(streamId: string): void {
  const current = streamMessages.get(streamId)
  if (!current) return
  streamMessages.set(streamId, {
    ...current,
    content: '',
    reasoning: '',
    timeline: [],
    toolCalls: [],
    activity: undefined
  })
  notifyStream(streamId)
}

export function clearStreamViewMessage(streamId: string): void {
  streamMessages.delete(streamId)
}

export function useStreamViewMessage(message: ChatMessage): ChatMessage {
  const streamId = message.streaming ? message.id : null
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!streamId) return () => undefined
      const listeners = streamListeners.get(streamId) ?? new Set<() => void>()
      listeners.add(listener)
      streamListeners.set(streamId, listeners)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) streamListeners.delete(streamId)
      }
    },
    [streamId]
  )
  const getSnapshot = useCallback(
    () => (streamId ? (streamMessages.get(streamId) ?? message) : message),
    [message, streamId]
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
