import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProposalDeckService } from '../service'
import { runProposalDeckTool } from '../tool'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('proposal deck chat journey', () => {
  it('runs every approval gate and queues local illustrations into the proposal workspace', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-proposal-flow-'))
    roots.push(root)
    const source = path.join(root, 'source')
    const output = path.join(root, 'output')
    fs.mkdirSync(source)
    fs.mkdirSync(output)
    fs.writeFileSync(path.join(source, 'reference.md'), 'Client proof: 5 days to 1 day.', 'utf8')
    const service = new ProposalDeckService({
      sessionsRoot: path.join(root, 'sessions')
    })
    const conversationId = 'proposal-chat'
    const call = (
      args: Record<string, unknown>,
      userMessage = ''
    ): ReturnType<typeof runProposalDeckTool> =>
      runProposalDeckTool(args, { conversationId, userMessage, service })

    expect(
      (
        await call({
          action: 'start',
          company: 'Acme',
          brief: 'Prove the claims cycle can move faster.',
          saleMode: 'transformation',
          geography: 'international',
          sourceFolder: source,
          outputFolder: output
        })
      ).text
    ).toContain('Client proof')

    await call({ action: 'save_narrative_plan', content: '# Narrative\nLead with cycle time.' })
    await call({
      action: 'revise_narrative_plan',
      content: '# Narrative\nLead with the client deadline, then cycle time.'
    })
    const notApproved = await call(
      { action: 'approve_narrative_plan' },
      'Move the proof before the program.'
    )
    expect(notApproved.text).toContain('Approval is not explicit')
    await call({ action: 'approve_narrative_plan' }, 'Looks good. Go ahead.')
    await call({ action: 'save_skeleton', content: '# Skeleton\n1. Faster claims' })
    await call({ action: 'approve_skeleton' }, 'Approved.')

    const studies = [
      {
        label: 'Insurer A',
        relevance: 'Same claims work',
        metrics: ['5 days', '1 day', '4 teams']
      },
      {
        label: 'Insurer B',
        relevance: 'Same buyer',
        metrics: ['10 hours', '2 hours', '3 systems']
      },
      {
        label: 'Bank C',
        relevance: 'Same controls',
        metrics: ['8 checks', '0 findings', '2 markets']
      }
    ]
    await call({ action: 'save_case_studies', content: '# Cases', caseStudies: studies })
    await call({ action: 'select_case_studies', selectedLabels: ['Insurer A', 'Insurer B'] })
    const fullCopy = await call({
      action: 'save_full_copy',
      content: '# Full Copy\n## Slide 1\nClaims move in one day.',
      illustrations: [
        { slide: 2, prompt: 'Charcoal portrait on white paper.', orientation: 'portrait' }
      ]
    })
    expect(fullCopy.imageRequests).toEqual([
      {
        prompt: 'Charcoal portrait on white paper.',
        proposal: { conversationId, slide: 2 }
      }
    ])
    const revised = await call({
      action: 'revise_full_copy',
      content: '# Full Copy\n## Slide 1\nClaims move before the renewal.',
      illustrations: [
        { slide: 2, prompt: 'Charcoal portrait with a clock.', orientation: 'portrait' }
      ]
    })
    expect(revised.imageRequests?.[0]?.prompt).toContain('clock')
    const regenerated = await call({
      action: 'regenerate_illustration',
      illustration: {
        slide: 2,
        prompt: 'Charcoal portrait with a clear renewal date.',
        orientation: 'portrait'
      }
    })
    expect(regenerated.imageRequests).toEqual([
      {
        prompt: 'Charcoal portrait with a clear renewal date.',
        proposal: { conversationId, slide: 2 }
      }
    ])
    const approved = await call({ action: 'approve_full_copy' }, 'I approve this.')
    expect(approved.text).toContain('Stage: complete')
    expect(approved.text).toContain('Now call computer_task with this exact goal')
    expect(approved.text).toContain('Save an editable .pptx and a .pdf')

    const session = service.get(conversationId)
    expect(session?.stage).toBe('complete')
    expect(fs.existsSync(path.join(session!.outputDir, 'narrative_plan.md'))).toBe(true)
    expect(fs.existsSync(path.join(session!.outputDir, 'skeleton.md'))).toBe(true)
    expect(fs.existsSync(path.join(session!.outputDir, 'case_studies.md'))).toBe(true)
    expect(fs.existsSync(path.join(session!.outputDir, 'full_copy.md'))).toBe(true)
    expect(fs.readFileSync(path.join(session!.outputDir, 'full_copy.md'), 'utf8')).toContain(
      'before the renewal'
    )
  })
})
