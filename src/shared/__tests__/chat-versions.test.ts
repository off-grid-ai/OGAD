import { expect, it } from 'vitest'
import { selectedVersionRepairs } from '../chat-versions'

it('repairs content without changing any saved context and is idempotent', () => {
  const row = {
    id: 1,
    content: 'new',
    context: JSON.stringify(
      {
        variants: ['old', 'new'],
        variantIndex: 0,
        sources: [{ name: 'source' }],
        toolCalls: [{ name: 'tool' }],
        status: 'complete',
        attachments: [{ path: '/image.png' }],
        imagePaths: ['/image.png'],
        metrics: { tokens: 20 },
        reasoning: 'Saved reasoning'
      },
      null,
      2
    )
  }
  const repaired = selectedVersionRepairs([row])
  expect(repaired).toEqual([{ ...row, content: 'old' }])
  expect(selectedVersionRepairs(repaired)).toEqual([])
})
it('leaves malformed context and invalid selections untouched', () => {
  const contexts = [
    '{',
    'null',
    '[]',
    '"string"',
    { variants: ['old', null], variantIndex: 0 },
    { variants: 'old', variantIndex: 0 },
    { variants: ['old', 'new'], variantIndex: '0' },
    { variants: ['old', 'new'], variantIndex: -1 },
    { variants: ['old', 'new'], variantIndex: 2 },
    { variants: ['old', 'new'], variantIndex: 0.5 }
  ]
  expect(
    selectedVersionRepairs(
      contexts.map((context, id) => ({
        id,
        content: 'new',
        context: typeof context === 'string' ? context : JSON.stringify(context)
      }))
    )
  ).toEqual([])
})
it('leaves all rows containing non-string versions untouched', () => {
  const object = { content: 'old', context: { sources: ['old'] }, fields: { reasoning: 'old' } }
  expect(
    selectedVersionRepairs([
      {
        id: 1,
        content: 'new',
        context: JSON.stringify({ variants: [object, 'new'], variantIndex: 0 })
      },
      {
        id: 2,
        content: 'new',
        context: JSON.stringify({ variants: ['old', object], variantIndex: 0 })
      }
    ])
  ).toEqual([])
})
