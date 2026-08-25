import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import { ProposalDeckService } from '../service'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function setup(): { root: string; source: string; output: string; service: ProposalDeckService } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-proposal-test-'))
  roots.push(root)
  const source = path.join(root, 'source')
  const output = path.join(root, 'proposals')
  fs.mkdirSync(source)
  fs.mkdirSync(output)
  fs.writeFileSync(path.join(source, 'source.md'), '# Approved reference\nClient-specific proof.')
  return {
    root,
    source,
    output,
    service: new ProposalDeckService({
      sessionsRoot: path.join(root, 'sessions')
    })
  }
}

describe('proposal deck service', () => {
  it('refuses local folders that the user cannot access', () => {
    const { output, service } = setup()
    expect(() =>
      service.start({
        conversationId: 'chat-invalid',
        company: 'Acme',
        brief: 'Use approved proof.',
        saleMode: 'transformation',
        geography: 'international',
        sourceFolder: '/path/that/does/not/exist',
        outputFolder: output
      })
    ).toThrow(/Content source must be a local folder/)
  })

  it('persists Browser Use website context before narrative work', async () => {
    const { source, output, service } = setup()
    const session = service.start({
      conversationId: 'chat-web',
      company: 'Acme',
      brief: 'Use current public positioning.',
      saleMode: 'transformation',
      geography: 'international',
      website: 'https://acme.example',
      sourceFolder: source,
      outputFolder: output
    })
    expect(session.stage).toBe('website_research')
    const next = service.transition(
      'chat-web',
      { kind: 'save_website_context' },
      'Founded to cut claim delays.'
    )
    expect(next.stage).toBe('narrative_plan')
    await expect(service.context(next)).resolves.toContain('Founded to cut claim delays.')
  })

  it('creates one durable workspace and saves the approved stage files', async () => {
    const { source, output, service } = setup()
    const started = service.start({
      conversationId: 'chat-1',
      company: 'Acme / Life',
      brief: 'Make the operating-cost problem visible.',
      saleMode: 'transformation',
      geography: 'international',
      sourceFolder: source,
      outputFolder: output
    })
    expect(started.outputDir).toContain('Acme - Life')
    expect(fs.readFileSync(path.join(started.outputDir, 'brief.md'), 'utf8')).toContain(
      'operating-cost problem'
    )
    await expect(service.context(started)).resolves.toContain('Client-specific proof.')

    const reviewed = service.transition(
      'chat-1',
      { kind: 'save_narrative_plan' },
      '# Narrative Plan\nLead with cost.'
    )
    expect(reviewed.stage).toBe('narrative_approval')
    expect(fs.readFileSync(path.join(started.outputDir, 'narrative_plan.md'), 'utf8')).toContain(
      'Lead with cost.'
    )
    expect(service.get('chat-1')?.stage).toBe('narrative_approval')
  })

  it('reads slide text from a PowerPoint inside the selected content folder', async () => {
    const { source, output, service } = setup()
    const zip = new JSZip()
    zip.file(
      'ppt/slides/slide1.xml',
      '<p:sld xmlns:a="a" xmlns:p="p"><a:t>Renewals move in one day</a:t></p:sld>'
    )
    fs.writeFileSync(
      path.join(source, 'client-deck.pptx'),
      await zip.generateAsync({ type: 'nodebuffer' })
    )
    const started = service.start({
      conversationId: 'chat-pptx',
      company: 'Acme',
      brief: 'Use the client deck.',
      saleMode: 'product-engineering',
      geography: 'international',
      sourceFolder: source,
      outputFolder: output
    })
    await expect(service.context(started)).resolves.toContain('Renewals move in one day')
  })

  it('never overwrites a prior engagement folder', () => {
    const { source, output, service } = setup()
    const first = service.start({
      conversationId: 'chat-1',
      company: 'Acme',
      brief: 'First meeting.',
      saleMode: 'product-engineering',
      geography: 'india',
      sourceFolder: source,
      outputFolder: output
    })
    const second = service.start({
      conversationId: 'chat-2',
      company: 'Acme',
      brief: 'Second meeting.',
      saleMode: 'product-engineering',
      geography: 'india',
      sourceFolder: source,
      outputFolder: output
    })
    expect(second.outputDir).not.toBe(first.outputDir)
    expect(fs.existsSync(first.outputDir)).toBe(true)
    expect(fs.existsSync(second.outputDir)).toBe(true)
  })
})
