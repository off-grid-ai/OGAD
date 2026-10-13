import { describe, it, expect } from 'vitest'
import { shouldQueue, enqueue, dequeue, queuedCount, clearQueue } from '../chat-queue'

describe('chat-queue routing', () => {
  it('queues only when THAT conversation is already generating', () => {
    const gen = new Set(['a'])
    expect(shouldQueue('a', gen)).toBe(true)
    expect(shouldQueue('b', gen)).toBe(false)
    expect(shouldQueue(null, gen)).toBe(false) // fresh chat always runs
  })

  it('enqueue/dequeue is FIFO and immutable', () => {
    const q0: Record<string, string[]> = {}
    const q1 = enqueue(q0, 'a', 'first')
    const q2 = enqueue(q1, 'a', 'second')
    expect(q0).toEqual({}) // original untouched
    expect(queuedCount(q2, 'a')).toBe(2)
    const { item, next } = dequeue(q2, 'a')
    expect(item).toBe('first')
    expect(queuedCount(next, 'a')).toBe(1)
  })

  describe('clearQueue (Stop drops a conversation queue)', () => {
    it('removes every queued send for the target conversation', () => {
      const q = { a: ['x', 'y'], b: ['z'] }
      const next = clearQueue(q, 'a')
      expect(queuedCount(next, 'a')).toBe(0)
      expect(next.a).toBeUndefined()
    })

    it('leaves other conversations untouched', () => {
      const q = { a: ['x'], b: ['z1', 'z2'] }
      const next = clearQueue(q, 'a')
      expect(next.b).toEqual(['z1', 'z2'])
    })

    it('is a no-op when the conversation has no queue', () => {
      const q = { b: ['z'] }
      expect(clearQueue(q, 'a')).toBe(q) // same reference, nothing to do
    })

    it('does not mutate the input', () => {
      const q = { a: ['x'], b: ['z'] }
      clearQueue(q, 'a')
      expect(q).toEqual({ a: ['x'], b: ['z'] })
    })
  })
})

it('sends a priority message before queued messages without losing their order', () => {
  let queue = enqueue({}, 'a', 'first')
  queue = enqueue(queue, 'a', 'second')
  queue = enqueue(queue, 'b', 'other chat')
  queue = enqueue(queue, 'a', 'send now', true)
  for (const expected of ['send now', 'first', 'second']) {
    const next = dequeue(queue, 'a')
    expect(next.item).toBe(expected)
    queue = next.next
  }
  expect(dequeue(queue, 'b').item).toBe('other chat')
})
