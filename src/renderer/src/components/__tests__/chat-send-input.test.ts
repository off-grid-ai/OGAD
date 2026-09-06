import { describe, expect, it } from 'vitest'
import type { Attachment } from '@renderer/lib/chat-transcript-types'
import { prepareChatInput } from '../chat-send-input'

const attachment = (overrides: Partial<Attachment>): Attachment => ({
  id: 'attachment-1',
  name: 'notes.txt',
  kind: 'text',
  text: 'attachment facts',
  status: 'ready',
  ...overrides
})

describe('prepareChatInput', () => {
  it('freezes the project, ready attachment text, and image paths at send time', () => {
    const result = prepareChatInput({
      draft: '  explain this  ',
      activeProjectId: 'project-a',
      attachments: [
        attachment({}),
        attachment({ id: 'image-1', name: 'frame.png', kind: 'image', path: '/tmp/frame.png' }),
        attachment({ id: 'loading-1', status: 'loading', text: 'not ready' })
      ]
    })

    expect(result.projectId).toBe('project-a')
    expect(result.atts).toHaveLength(2)
    expect(result.modelQuery).toContain('attachment facts')
    expect(result.modelQuery).toContain('explain this')
    expect(result.imagePaths).toEqual(['/tmp/frame.png'])
  })

  it('uses explicit replay attachments and project scope without consuming the draft', () => {
    const result = prepareChatInput({
      override: 'retry',
      options: {
        regen: true,
        projectIdOverride: null,
        atts: [attachment({ id: 'replay-1', text: 'saved facts' })]
      },
      draft: 'unrelated draft',
      activeProjectId: 'project-a',
      attachments: []
    })

    expect(result.isInput).toBe(false)
    expect(result.regen).toBe(true)
    expect(result.projectId).toBeNull()
    expect(result.typed).toBe('retry')
    expect(result.modelQuery).not.toContain('unrelated draft')
  })
})
