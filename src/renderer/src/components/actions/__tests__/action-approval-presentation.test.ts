import { describe, expect, it } from 'vitest'
import { approvalListTitle, toolActionLabel } from '../action-approval-presentation'

describe('approval wording', () => {
  it('says what a tool does instead of its id', () => {
    expect(toolActionLabel('notion-create-pages', 'Notion')).toBe('Create pages')
    expect(toolActionLabel('ask_question', 'DeepWiki')).toBe('Ask question')
    expect(toolActionLabel('notion-send-message-to-session', 'Notion')).toBe(
      'Send message to session'
    )
    expect(toolActionLabel('web_use', null)).toBe('Browse the web')
    expect(toolActionLabel('computer_use', null)).toBe('Use the computer')
  })

  it('replaces a title that is only the tool id, and keeps a written one', () => {
    expect(
      approvalListTitle({
        title: 'ask_question via DeepWiki',
        tool: 'ask_question',
        connector: 'DeepWiki'
      })
    ).toBe('Ask question in DeepWiki')
    expect(
      approvalListTitle({ title: null, tool: 'notion-create-pages', connector: 'Notion' })
    ).toBe('Create pages in Notion')
    expect(
      approvalListTitle({
        title: 'Log placement drive invitation',
        tool: 'notion-create-pages',
        connector: 'Notion'
      })
    ).toBe('Log placement drive invitation')
  })
})
