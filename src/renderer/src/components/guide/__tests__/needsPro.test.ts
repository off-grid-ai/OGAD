/** The guide's Pro label for a catalog screen comes from the shared feature parts. */
import { expect, it } from 'vitest'
import { PRO_FEATURES } from '../../pro/proCatalog'
import { needsPro } from '../guideKnowledge'

it('Web Use and Computer Use are free; every other catalog screen stays Pro', () => {
  const free = PRO_FEATURES.map((f) => f.route).filter((r) => !needsPro(r))
  expect(free).toEqual(['tasks'])
})

it('a screen no shared part names stays Pro', () => {
  expect(needsPro('no-such-screen')).toBe(true)
})
