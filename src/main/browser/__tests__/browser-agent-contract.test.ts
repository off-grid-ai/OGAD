import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  actorRequest,
  boundedSnapshot,
  checkLines,
  compactSnapshot,
  evaluateCheck,
  evaluatorRequest,
  obviousAction,
  planLines,
  pastLines,
  plannerRequest,
  plannerResponse
} from '@offgrid/use'

/** scripts/action-data/contract.mjs: the request builders the training rows are made with. */
const training = (await import(
  /* @vite-ignore */ path.resolve(import.meta.dirname, '../../../../scripts/action-data/contract.mjs')
)) as {
  boundedSnapshot: typeof boundedSnapshot
  compactSnapshot: typeof compactSnapshot
  checkLines: typeof checkLines
  evaluateCheck: typeof evaluateCheck
  obviousAction: typeof obviousAction
  planLines: typeof planLines
  pastLines: typeof pastLines
  plannerRequest: typeof plannerRequest
  plannerResponse: typeof plannerResponse
  actorRequest: typeof actorRequest
  evaluatorRequest: typeof evaluatorRequest
}

// The harness and the training rows must build the same request text, byte for byte: the
// trained planner, actor and evaluator depend on it (docs/MODEL_CONTRACT.md).

const goal =
  'Fill Email address under Home address with rohan88@example.com, check "Agree to terms and conditions" and save the form.'
const snapshot = [
  '### Page state',
  '- Page URL: https://forms.example.com/contact',
  '- Page Title: Contact',
  '- Page Snapshot:',
  '```yaml',
  '- region "Home address" [ref=e11]:',
  '  - textbox "Email address" [ref=e15]: rohan88@example.com',
  '  - checkbox "Agree to terms and conditions" [checked] [ref=e26]',
  '  - textbox "Given name" [ref=e28]: Asha',
  '- button "Save" [ref=e42]',
  '```'
].join('\n')
const plan = [
  { title: 'Set Home Email to rohan88@example.com', check: 'textbox "Email address" = rohan88@example.com' },
  { title: 'Check Agree to terms', check: 'checkbox "Agree to terms and conditions" checked' },
  { title: 'Save the form', check: 'text "Saved"' }
]
const past = Array.from({ length: 12 }, (_, i) => `type(e${i},"value ${i}") -> ok, page changed`)

/** A snapshot over the 18,000-character limit, so the shortening path runs. */
const longSnapshot = Array.from({ length: 900 }, (_, i) =>
  i % 7 === 0
    ? `  - link "Article ${i} about rohan88 and terms" [ref=e${i}]`
    : `  - text: filler paragraph number ${i} with some ordinary words in it`
).join('\n')

/**
 * A real-site shape (Mind2Web through OGAD's snapshot): unnamed generic wrappers, link URLs, and a
 * page still over the limit after compaction, with the current step's target near the bottom.
 */
const realSite = [
  '### Page state',
  '- Page URL: https://shop.example.com/search',
  '- Page Title: Search results',
  '- Page Snapshot:',
  '```yaml',
  ...Array.from({ length: 700 }, (_, i) =>
    [
      `- generic [ref=w${i}]:`,
      i % 5 === 0 ? `  - generic [active] [ref=a${i}]` : `  - generic [ref=x${i}]`,
      `  - link "Product ${i} details" [ref=e${i}]:`,
      `    - /url: /product/${i}?ref=search&page=${Math.floor(i / 20)}`,
      `  - text: ordinary description of product ${i} with several words to fill the line`,
      i % 9 === 0
        ? `  - button "Add product ${i} to cart" [ref=b${i}]`
        : i % 4 === 0
          ? // Playwright YAML-quotes a line whose name has a colon.
            `  - 'checkbox "Select mail from Notion: Trip ${i}" [ref=f3e${i}]'`
          : `  - paragraph [ref=p${i}]: rating ${i % 5} stars`
    ].join('\n')
  ),
  '- region "Delivery" [ref=r1]:',
  '  - combobox "Delivery postcode" [ref=e9001]',
  '  - button "Apply postcode" [ref=e9002]',
  `  - 'link "Delivery rules: postcode 560001" [ref=e9003]':`,
  '    - /url: /delivery/rules',
  '```'
].join('\n')
const realGoal = 'Set the delivery postcode to 560001 and add the cheapest kettle to the cart.'
const realPlan = [
  { title: 'Set delivery postcode to 560001', check: 'combobox "Delivery postcode" = 560001' },
  { title: 'Add the cheapest kettle to the cart', check: 'text "Added to cart"' }
]

describe('planner / actor / evaluator requests match the training contract', () => {
  it('shortens a long snapshot the same way', () => {
    expect(longSnapshot.length).toBeGreaterThan(18_000)
    expect(boundedSnapshot(longSnapshot, goal)).toBe(training.boundedSnapshot(longSnapshot, goal))
    expect(boundedSnapshot(snapshot, goal)).toBe(training.boundedSnapshot(snapshot, goal))
  })

  it('compacts and cuts a real-site snapshot the same way', () => {
    const compact = compactSnapshot(realSite)
    expect(compact).toBe(training.compactSnapshot(realSite))
    expect(compact).not.toMatch(/- generic( \[active\])? \[ref=[^\]]+\]:?$/m)
    expect(compact).not.toContain('/url:')
    expect(compact.length).toBeGreaterThan(18_000)
    for (const focus of ['', realPlan[0]?.title ?? '', realPlan[1]?.title ?? '']) {
      expect(boundedSnapshot(realSite, realGoal, focus)).toBe(
        training.boundedSnapshot(realSite, realGoal, focus)
      )
    }
    // The current step's control at the bottom of the page survives the cut.
    expect(boundedSnapshot(realSite, realGoal, realPlan[0]?.title)).toContain('[ref=e9001]')
    expect(boundedSnapshot(realSite, realGoal, realPlan[0]?.title)).toContain(
      `- 'link "Delivery rules: postcode 560001" [ref=e9003]':`
    )
  })

  it('writes plan and past lines the same way', () => {
    for (const current of [1, 2, 3, 4]) {
      expect(planLines(plan, current)).toBe(training.planLines(plan, current))
      expect(planLines(plan, current, true)).toBe(training.planLines(plan, current, true))
    }
    expect(pastLines(past)).toBe(training.pastLines(past))
    expect(pastLines(past, 3)).toBe(training.pastLines(past, 3))
    expect(plannerResponse(plan, 4)).toBe(training.plannerResponse(plan, 4))
  })

  it('builds planner and re-planner requests the same way', () => {
    expect(plannerRequest({ goal, snapshot })).toBe(training.plannerRequest({ goal, snapshot }))
    const replan = { goal, snapshot: longSnapshot, done: plan.slice(0, 2), reason: 'left the task' }
    expect(plannerRequest(replan)).toBe(training.plannerRequest(replan))
    const real = { goal: realGoal, snapshot: realSite }
    expect(plannerRequest(real)).toBe(training.plannerRequest(real))
  })

  it('builds actor requests the same way', () => {
    for (const shown of [[], past.slice(0, 3), past]) {
      const request = { goal, plan, current: 2, past: shown, snapshot }
      expect(actorRequest(request)).toBe(training.actorRequest(request))
    }
    const long = { goal, plan, current: 3, past, snapshot: longSnapshot }
    expect(actorRequest(long)).toBe(training.actorRequest(long))
    for (const current of [1, 2]) {
      const real = { goal: realGoal, plan: realPlan, current, past, snapshot: realSite }
      expect(actorRequest(real)).toBe(training.actorRequest(real))
    }
  })

  it('builds evaluator requests the same way', () => {
    const cases = [
      { past: [], last: 'task started' },
      { past: past.slice(0, 1), last: past[0] ?? '' },
      { past, last: past.at(-1) ?? '' },
      { past, last: 'user took over -> signed in' }
    ]
    for (const { past: shown, last } of cases) {
      const request = { goal, plan, current: 2, past: shown, last, snapshot }
      expect(evaluatorRequest(request)).toBe(training.evaluatorRequest(request))
      const real = { goal: realGoal, plan: realPlan, current: 2, past: shown, last, snapshot: realSite }
      expect(evaluatorRequest(real)).toBe(training.evaluatorRequest(real))
    }
    // PAST holds the 3 actions before LAST, numbered by their true index.
    expect(evaluatorRequest({ goal, plan, current: 2, past, last: past.at(-1) ?? '', snapshot })).toContain(
      `PAST:\n9 ${past[8]}\n10 ${past[9]}\n11 ${past[10]}\nLAST: ${past[11]}\n`
    )
  })
})

/** A form with sections, a dropdown, a duplicate label, a disabled field and a Save button. */
const form = [
  '- Page URL: https://forms.example.com/order',
  '- heading "Order" [level=1] [ref=e1]',
  '- region "Shipping" [ref=e2]:',
  '  - textbox "Name" [ref=e3]',
  '  - textbox "Email address" [ref=e4]: rohan88@example.com',
  '- region "Billing" [ref=e5]:',
  '  - textbox "Name" [ref=e6]: Meera',
  '- combobox "Country" [ref=e7]:',
  '  - option "India"',
  '  - option "Japan" [selected]',
  '- textbox "Given name" [ref=e8]',
  `- 'checkbox "Agree: terms" [ref=e9]'`,
  '- checkbox "Newsletter" [checked] [ref=e10]',
  '- textbox "Coupon" [disabled] [ref=e11]',
  '- textbox "Notes" [ref=e12]: call first',
  '- button "Save" [ref=e13]',
  '- link "Help" [ref=e14]',
  '- link "Help" [ref=e15]'
].join('\n')

describe('harness checks match the training contract', () => {
  const step = (title: string, check: string): { title: string; check: string } => ({ title, check })
  const cases: [string, { title: string; check: string }, string | null][] = [
    ['a unique field', step('Set Given name to Asha', 'textbox "Given name" = Asha'), 'type(e8,"Asha")'],
    ['a dropdown', step('Choose India', 'combobox "Country" = India'), 'select(e7,"India")'],
    ['a section-scoped field', step('Set Shipping name', 'textbox "Name" in Shipping = Rohan'), 'type(e3,"Rohan")'],
    ['an ambiguous duplicate', step('Set name', 'textbox "Name" = Rohan'), null],
    ['an already-met check', step('Set email', 'textbox "Email address" in Shipping = rohan88@example.com'), null],
    ['a disabled control', step('Enter coupon', 'textbox "Coupon" = SAVE10'), null],
    ['a click whose check is the result', step('Click Save', 'text "Saved"'), 'click(e13)'],
    ['a click with two matching links', step('Open Help', 'heading "Help"'), null],
    ['a YAML-quoted checkbox', step('Agree to the terms', 'checkbox "Agree: terms" checked'), 'check(e9)'],
    ['an uncheck', step('Leave the newsletter', 'checkbox "Newsletter" not checked'), 'uncheck(e10)'],
    ['an empty field', step('Clear the notes', 'textbox "Notes" is empty'), 'clear(e12)'],
    ['a check code cannot test', step('Pick the cheapest', 'the cheapest item is in the cart'), null]
  ]
  for (const [name, planStep, expected] of cases) {
    it(`obviousAction: ${name}`, () => {
      expect(obviousAction(planStep, form)).toBe(expected)
      expect(obviousAction(planStep, form)).toBe(training.obviousAction(planStep, form))
    })
  }

  it('evaluates checks and writes the CHECKS line the same way', () => {
    const checked = cases.map(([, planStep]) => planStep)
    for (const { check } of checked) {
      expect(evaluateCheck(check, form)).toBe(training.evaluateCheck(check, form))
    }
    expect(evaluateCheck('url contains /order', form)).toBe(true)
    expect(evaluateCheck('heading "Order"', form)).toBe(true)
    expect(checkLines(checked, form)).toBe(training.checkLines(checked, form))
    expect(checkLines(checked.slice(0, 5), form)).toBe('1 ✗ 2 ✗ 3 ✗ 4 ? 5 ✓')
  })

  it('puts CHECKS after PLAN in evaluator requests only', () => {
    const formPlan = [
      step('Set email', 'textbox "Email address" in Shipping = rohan88@example.com'),
      step('Set Given name to Asha', 'textbox "Given name" = Asha'),
      step('Pick the cheapest', 'the cheapest item is in the cart')
    ]
    const request = { goal, plan: formPlan, current: 2, past, last: past.at(-1) ?? '', snapshot: form }
    const evaluator = evaluatorRequest(request)
    expect(evaluator).toBe(training.evaluatorRequest(request))
    expect(evaluator).toContain('check: the cheapest item is in the cart\nCHECKS: 1 ✓ 2 ✗ 3 ?\nPAST:\n')
    expect(actorRequest(request)).toBe(training.actorRequest(request))
    expect(actorRequest(request)).not.toContain('CHECKS:')
  })
})
