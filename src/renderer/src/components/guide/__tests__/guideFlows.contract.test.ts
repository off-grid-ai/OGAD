/**
 * Contract: the guide's "how do I…" flows for the computer (@offgrid/models GUIDE_FLOWS) answer with
 * this app's own labels, word for word and with no model. This fails when a label a flow names is
 * no longer in the app, or a flow's card is a topic this guide does not show. Fix the flow in
 * shared/packages/models/src/guide-kb/desktop.json and run `npm run build:guide-kb` there.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { GUIDE_FLOWS, GUIDE_NOT_SUPPORTED, guideFlowLabels } from '@offgrid/models'
import { guideTopics } from '../guideKnowledge'

const ROOT = path.resolve(__dirname, '../../../../../..')
const SKIP = new Set(['node_modules', '__tests__', 'docs', 'e2e', 'coverage', 'dist', 'out'])

function read(dir: string, into: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const file = path.join(dir, name)
    if (fs.statSync(file).isDirectory()) read(file, into)
    else if (/\.(tsx?|swift)$/.test(name) && !/\.test\./.test(name))
      // JSX writes "&" as "&amp;", and a style can capitalize a tab named in lower case.
      into.push(fs.readFileSync(file, 'utf8').replace(/&amp;/g, '&').toLowerCase())
  }
}

const texts: string[] = []
for (const dir of ['src', 'pro']) read(path.join(ROOT, dir), texts)
// Pro is a private submodule: a checkout without it skips the flows whose code lives there.
const hasPro = fs.existsSync(path.join(ROOT, 'pro', 'package.json'))

const computer = [...GUIDE_FLOWS, ...GUIDE_NOT_SUPPORTED].filter((e) => e.surface === 'desktop')
const checked = computer.filter((e) => hasPro || !e.source.startsWith('pro/'))

describe('guide flows match the desktop app', () => {
  it('has desktop flows to check', () => {
    expect(computer.length).toBeGreaterThan(100)
  })

  it.each(checked.map((e) => [e.id, e] as const))('%s cites a file that exists', (_id, entry) => {
    expect(fs.existsSync(path.join(ROOT, entry.source.replace(/:\d+$/, '')))).toBe(true)
  })

  const flows = GUIDE_FLOWS.filter((f) => checked.includes(f))
  it.each(flows.map((f) => [f.id, f] as const))('%s names only labels the app shows', (_id, flow) => {
    const missing = guideFlowLabels(flow).filter((label: string) => !texts.some((t) => t.includes(label.toLowerCase())))
    expect(missing).toEqual([])
  })

  // "computer" marks the app's own settings (Gateway, updates, backup, licence): those answers show
  // with no card. Every other topic must be one this guide shows.
  it("shows each flow's card from this guide's topics", () => {
    const ids = new Set([...guideTopics('darwin').map((t) => t.id), 'computer'])
    expect(computer.filter((e) => !ids.has(e.topic)).map((e) => `${e.id}: ${e.topic}`)).toEqual([])
  })
})
