import { describe, expect, it } from 'vitest'
import { advanceProposal, isExplicitProposalApproval, type ProposalSession } from '../state'

function session(stage: ProposalSession['stage']): ProposalSession {
  return {
    version: 2,
    conversationId: 'chat-1',
    company: 'Client',
    brief: 'A renewal meeting.',
    saleMode: 'transformation',
    geography: 'international',
    sourceFolder: '/tmp/source',
    outputRoot: '/tmp/output',
    outputDir: '/tmp/proposal',
    stage,
    caseStudies: [],
    selectedCaseStudies: [],
    illustrations: [],
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z'
  }
}

describe('proposal gate state', () => {
  it('requires every approval before the next content stage', () => {
    const narrativeReview = advanceProposal(session('narrative_plan'), {
      kind: 'save_narrative_plan'
    })
    expect(narrativeReview.stage).toBe('narrative_approval')
    expect(() => advanceProposal(narrativeReview, { kind: 'save_skeleton' })).toThrow(
      /Expected skeleton/
    )
    expect(advanceProposal(narrativeReview, { kind: 'approve_narrative_plan' }).stage).toBe(
      'skeleton'
    )
  })

  it('keeps a revised stage at its approval gate', () => {
    const narrative = advanceProposal(session('narrative_approval'), {
      kind: 'revise_narrative_plan'
    })
    const skeleton = advanceProposal(session('skeleton_approval'), { kind: 'revise_skeleton' })
    const fullCopy = advanceProposal(session('full_copy_approval'), {
      kind: 'revise_full_copy',
      illustrations: [
        { slide: 3, prompt: 'A charcoal map on white paper.', orientation: 'landscape' }
      ]
    })
    expect(narrative.stage).toBe('narrative_approval')
    expect(skeleton.stage).toBe('skeleton_approval')
    expect(fullCopy.stage).toBe('full_copy_approval')
  })

  it('regenerates one existing illustration without leaving final review', () => {
    const current = {
      ...session('full_copy_approval'),
      illustrations: [
        { slide: 2, prompt: 'Old portrait', orientation: 'portrait' as const },
        { slide: 4, prompt: 'Keep landscape', orientation: 'landscape' as const }
      ]
    }
    const next = advanceProposal(current, {
      kind: 'regenerate_illustration',
      illustration: { slide: 2, prompt: 'New portrait', orientation: 'portrait' }
    })
    expect(next.stage).toBe('full_copy_approval')
    expect(next.illustrations).toEqual([
      { slide: 2, prompt: 'New portrait', orientation: 'portrait' },
      { slide: 4, prompt: 'Keep landscape', orientation: 'landscape' }
    ])
    expect(() =>
      advanceProposal(current, {
        kind: 'regenerate_illustration',
        illustration: { slide: 9, prompt: 'Not assigned', orientation: 'portrait' }
      })
    ).toThrow(/already assigned/)
  })

  it('blocks case studies without three confirmed metrics', () => {
    expect(() =>
      advanceProposal(session('case_studies'), {
        kind: 'save_case_studies',
        caseStudies: [
          { label: 'A', relevance: 'Same work', metrics: ['1 day', '2 teams'] },
          { label: 'B', relevance: 'Same market', metrics: ['1 day', '2 teams', '3 systems'] },
          { label: 'C', relevance: 'Same buyer', metrics: ['1 day', '2 teams', '3 systems'] }
        ]
      })
    ).toThrow(/three confirmed outcome metrics/)
  })

  it('accepts exactly two selected studies from the ranked list', () => {
    const ranked = [
      { label: 'A', relevance: 'Same work', metrics: ['1 day', '2 teams', '3 systems'] },
      { label: 'B', relevance: 'Same market', metrics: ['4 days', '5 teams', '6 systems'] },
      { label: 'C', relevance: 'Same buyer', metrics: ['7 days', '8 teams', '9 systems'] }
    ]
    const current = { ...session('case_study_selection'), caseStudies: ranked }
    const next = advanceProposal(current, {
      kind: 'select_case_studies',
      selectedLabels: ['A', 'C']
    })
    expect(next.stage).toBe('full_copy')
    expect(next.selectedCaseStudies.map((item) => item.label)).toEqual(['A', 'C'])
  })

  it('recognizes explicit approval without treating ordinary feedback as approval', () => {
    expect(isExplicitProposalApproval('Looks good. Go ahead.')).toBe(true)
    expect(isExplicitProposalApproval('Move slide 3 before slide 2.')).toBe(false)
  })
})
