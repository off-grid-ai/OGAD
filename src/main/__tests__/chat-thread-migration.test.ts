import { describe, expect, it } from 'vitest'
import { chatThread, THREAD_ROOT } from '@offgrid/sync'
import { planThreadMigration, type StoredThreadRow } from '../chat-thread-migration'

const row = (
  id: number,
  role: 'user' | 'assistant',
  content: string,
  context?: Record<string, unknown>
): StoredThreadRow => ({
  id,
  uuid: `m${id}`,
  role,
  content,
  context: context ? JSON.stringify(context) : null,
  createdMs: 1_000 + id * 1_000
})

/** The chat after the plan: updated rows plus inserted ones, read the way main reads them. */
function migrated(rows: StoredThreadRow[]): {
  plan: ReturnType<typeof planThreadMigration>
  thread: ReturnType<
    typeof chatThread<{ uuid: string; parent?: string; selectedAt?: number; content: string }>
  >
} {
  let next = 0
  const plan = planThreadMigration(rows, () => `new${++next}`)
  const updated = new Map(plan.updates.map((update) => [update.uuid, update.context]))
  const all = [
    ...rows.map((r) => ({
      uuid: r.uuid,
      role: r.role,
      content: r.content,
      createdMs: r.createdMs,
      context: updated.get(r.uuid) ?? JSON.parse(r.context ?? '{}')
    })),
    ...plan.inserts
  ].sort((a, b) => a.createdMs - b.createdMs)
  const thread = chatThread(
    all.map((entry) => ({
      ...entry,
      parent: entry.context.parent as string | undefined,
      selectedAt: entry.context.selectedAt as number | undefined
    }))
  )
  return { plan, thread }
}

describe('migrating versions kept inside a message', () => {
  it('leaves a chat without them alone', () => {
    expect(
      planThreadMigration([row(1, 'user', 'Hi'), row(2, 'assistant', 'Hello')], () => 'x')
    ).toEqual({
      updates: [],
      inserts: []
    })
  })

  it("turns an answer's versions into version rows, keeping order and the shown one", () => {
    const { plan, thread } = migrated([
      row(1, 'user', 'Question'),
      row(2, 'assistant', 'Second', {
        variants: ['First', { content: 'Second', context: { reasoning: 'r2' } }, 'Third'],
        variantIndex: 1
      }),
      row(3, 'user', 'Later'),
      row(4, 'assistant', 'Later answer')
    ])
    expect(plan.inserts.map((insert) => insert.content)).toEqual(['First', 'Third'])
    expect(plan.inserts.every((insert) => insert.context.parent === 'm1')).toBe(true)
    // The shown version keeps its later turns; the other versions sit beside it, in order.
    expect(thread.messages.map((message) => message.content)).toEqual([
      'Question',
      'Second',
      'Later',
      'Later answer'
    ])
    expect(thread.versions.get('m2')).toEqual({ index: 1, count: 3, uuids: ['new1', 'm2', 'new2'] })
    const stripped = plan.updates.find((update) => update.uuid === 'm2')!.context
    expect(stripped.variants).toBeUndefined()
    expect(stripped.variantIndex).toBeUndefined()
  })

  it("turns an edited question's old wording and answers into a version of the question", () => {
    const { plan, thread } = migrated([
      row(1, 'user', 'New wording', {
        branches: [{ question: 'Old wording', answers: ['Old answer'] }]
      }),
      row(2, 'assistant', 'New answer')
    ])
    expect(plan.inserts.map((insert) => [insert.role, insert.content])).toEqual([
      ['user', 'Old wording'],
      ['assistant', 'Old answer']
    ])
    expect(plan.inserts[0]!.context.parent).toBe(THREAD_ROOT)
    expect(plan.inserts[1]!.context.parent).toBe(plan.inserts[0]!.uuid)
    expect(thread.messages.map((message) => message.content)).toEqual(['New wording', 'New answer'])
    expect(thread.versions.get('m1')?.count).toBe(2)
  })
})
