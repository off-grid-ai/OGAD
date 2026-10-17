// Task generator and label script. The label script reads the page spec and the page's live
// state. It returns the plan (planner label), every correct next action (actor label), and the
// verdict (evaluator label). Targets are data-gen-id values marked `@id`; capture.mjs turns them
// into OGAD snapshot refs. `*` in an accepted action matches any text.

import { createRng } from './rng.mjs'
import { PRODUCTS } from './vocab-pools.mjs'

const q = (text) => JSON.stringify(String(text))
const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1)

export function generateTask(spec, seed) {
  const rng = createRng(`${seed}:task`)
  if (spec.family === 'form' || spec.family === 'wizard') return formTask(spec, rng)
  if (spec.family === 'bulk') return bulkTask(spec, rng)
  return listTask(spec, rng)
}

// ---------- form and wizard ----------

const fieldsOf = (spec) => spec.pages.flatMap((page, pageIndex) =>
  page.sections.flatMap((section) => section.fields.map((field) => ({ field, section, pageIndex }))))

function formTask(spec, rng) {
  const all = fieldsOf(spec)
  const perPage = spec.family === 'wizard' ? 3 : 5
  const chosen = spec.pages.flatMap((_, pageIndex) => {
    const onPage = all.filter((f) => f.pageIndex === pageIndex)
    return rng.sample(onPage, rng.int(1, Math.min(perPage, onPage.length)))
  })
  const order = new Map(all.map(({ field }, index) => [field.id, index]))
  const twinTitles = new Set(spec.pages.filter((p) => p.sections.length > 1).flatMap((p) => p.sections.map((s) => s.title)))
  const targets = chosen.map(({ field, section, pageIndex }) => ({
    id: field.id, kind: field.kind, label: field.label, section: section.title, pageIndex,
    twin: twinTitles.has(section.title), value: targetValue(field, rng), options: field.options
  })).sort((a, b) => order.get(a.id) - order.get(b.id))
  const askReference = rng.chance(0.4)
  const submit = spec.submit.label.toLowerCase()
  const finish = askReference
    ? rng.pick([`then ${submit} and tell me the reference number`, `then click ${spec.submit.label} and report the reference`])
    : rng.pick([`then ${submit}`, `then click ${spec.submit.label}`, `and finish with ${spec.submit.label}`])
  const parts = targets.map((t) => phraseField(t, rng))
  const goal = `${capitalise(joinParts(parts, rng))}, ${finish}.`
  return { family: spec.family, goal, targets, askReference, answer: askReference ? spec.reference : 'Saved' }
}

function targetValue(field, rng) {
  switch (field.kind) {
    case 'select': return rng.pick(field.options.filter((o) => o !== field.initial))
    case 'radio': return rng.pick(field.options)
    case 'checkbox': return !field.initial
    default: return (FIELD_VALUES[field.key] ?? (() => 'Sample text'))(rng)
  }
}

const FIELD_VALUES = {
  first: (r) => r.pick(['Asha', 'Rohan', 'Meera', 'Kabir', 'Leena']),
  last: (r) => r.pick(['Rao', 'Shah', 'Iyer', 'Mehta', 'Khan']),
  name: (r) => `${r.pick(['Asha', 'Rohan', 'Meera', 'Kabir', 'Leena', 'Arjun'])} ${r.pick(['Rao', 'Shah', 'Iyer', 'Mehta'])}`,
  email: (r) => `${r.pick(['asha', 'rohan', 'meera', 'kabir', 'dev'])}${r.int(1, 99)}@example.com`,
  phone: (r) => `9${r.int(100000000, 999999999)}`,
  city: (r) => r.pick(['Pune', 'Mumbai', 'Chennai', 'Kochi', 'Jaipur', 'Indore']),
  zip: (r) => String(r.int(110000, 899999)),
  qty: (r) => String(r.int(1, 25)),
  guests: (r) => String(r.int(1, 8)),
  company: (r) => `${r.pick(['Rao', 'Shah', 'Iyer'])} ${r.pick(['Labs', 'Traders', 'Foods'])}`,
  notes: (r) => r.pick(['Please call before delivery.', 'Leave at the front desk.', 'Urgent request.'])
}

const where = (t) => (t.twin ? `${t.section} ${t.label}` : t.label)

function phraseField(t, rng) {
  const w = t.twin ? rng.pick([`the ${t.section} ${t.label.toLowerCase()}`, `${t.label} under ${t.section}`, `${t.section} ${t.label}`]) : rng.pick([t.label, `the ${t.label.toLowerCase()}`])
  switch (t.kind) {
    case 'checkbox': return t.value ? rng.pick([`tick "${t.label}"`, `check "${t.label}"`]) : rng.pick([`untick "${t.label}"`, `uncheck "${t.label}"`])
    case 'radio': return rng.pick([`choose ${t.value} for ${w}`, `set ${w} to ${t.value}`])
    case 'select': return rng.pick([`select ${t.value} as ${w}`, `set ${w} to ${t.value}`])
    default: return rng.pick([`set ${w} to ${t.value}`, `enter ${t.value} as ${w}`, `fill ${w} with ${t.value}`])
  }
}

function formPlan(spec, task, state) {
  const steps = []
  if (spec.gate?.kind === 'login' && !state.gatePassed) steps.push({ title: 'Sign in', check: 'the form is shown', test: { type: 'gatePassed' } })
  // Plan only what is on screen: wizard pages after the current one are unknown until they open,
  // and the evaluator asks for a re-plan when one does.
  const lastPage = spec.family === 'wizard' ? state.wizardPage : spec.pages.length - 1
  spec.pages.forEach((page, pageIndex) => {
    if (pageIndex > lastPage) return
    for (const t of task.targets.filter((x) => x.pageIndex === pageIndex)) {
      const section = page.sections.find((s) => s.title === t.section)
      const hidden = section.collapsed && section.fields.findIndex((f) => f.id === t.id) >= Math.ceil(section.fields.length / 2)
      if (hidden && !steps.some((s) => s.test.id === section.toggleId)) {
        steps.push({ title: `Open ${section.toggleLabel}`, check: `${section.toggleLabel} fields are shown`, test: { type: 'revealedOrDone', id: section.toggleId, field: t.id, value: t.value } })
      }
      steps.push(fieldStep(t))
    }
    if (spec.family === 'wizard' && pageIndex < spec.pages.length - 1) {
      steps.push({ title: 'Continue to the next step', check: `step ${pageIndex + 2} of ${spec.pages.length} is shown`, test: { type: 'wizardPage', page: pageIndex + 1 } })
    }
  })
  // A slow save is not known in advance, so waiting for it belongs to this step.
  if (lastPage === spec.pages.length - 1) steps.push({ title: `Click ${spec.submit.label}`, check: 'text "Saved" or the next screen', test: { type: 'sent' } })
  return steps
}

function fieldStep(t) {
  if (t.kind === 'checkbox') return { title: `${t.value ? 'Check' : 'Uncheck'} ${t.label}`, check: `checkbox "${t.label}" ${t.value ? 'checked' : 'not checked'}`, test: { type: 'value', id: t.id, value: t.value } }
  const role = t.kind === 'select' ? 'combobox' : t.kind === 'radio' ? 'radio' : 'textbox'
  const inSection = t.twin ? ` in ${t.section}` : ''
  return { title: `Set ${where(t)} to ${t.value}`, check: `${role} "${t.label}"${inSection} = ${t.value}`, test: { type: 'value', id: t.id, value: t.value } }
}

function formActions(spec, task, state) {
  const visible = new Set(state.visible)
  if (spec.family === 'wizard') {
    const pending = task.targets.filter((t) => t.pageIndex === state.wizardPage && state.values[t.id] !== t.value)
    const page = spec.pages[state.wizardPage]
    if (!pending.length && state.wizardPage < spec.pages.length - 1) return [`click(@${page.nextId})`]
  }
  const actions = []
  const toggles = []
  for (const t of task.targets) {
    if (state.values[t.id] === t.value) continue
    const controlId = t.kind === 'radio' ? `${t.id}-${t.options.indexOf(t.value)}` : t.id
    if (!visible.has(controlId)) {
      const section = spec.pages[t.pageIndex].sections.find((s) => s.title === t.section)
      if (section.toggleId && visible.has(section.toggleId)) toggles.push(`click(@${section.toggleId})`)
      continue
    }
    actions.push(...fieldActions(t, controlId))
  }
  if (actions.length || toggles.length) return [...new Set([...actions, ...toggles])]
  if (state.saving) return ['wait_idle()', 'wait(*)']
  if (!state.submitted) return [`click(@${spec.submit.id})`]
  return []
}

function fieldActions(t, controlId) {
  switch (t.kind) {
    case 'select': return [`select(@${controlId},${q(t.value)})`]
    case 'radio': return [`click(@${controlId})`, `check(@${controlId})`]
    case 'checkbox': return t.value ? [`check(@${controlId})`, `click(@${controlId})`] : [`uncheck(@${controlId})`, `click(@${controlId})`]
    default: return [`type(@${controlId},${q(t.value)})`]
  }
}

// ---------- single-item list tasks ----------

function listTask(spec, rng) {
  const missing = rng.chance(0.25)
  if (missing) {
    const name = rng.pick(PRODUCTS.filter((p) => !spec.rows.some((r) => r.name === p)))
    return { family: 'list', kind: 'missing', name, goal: rng.pick([`What is the price of the ${name}?`, `Delete ${name} from the list.`, `Open ${name}.`]) }
  }
  const row = rng.pick(spec.rows)
  const kind = rng.pick(['act', 'act', 'read', 'open'])
  const verb = spec.rowAction.toLowerCase()
  if (kind === 'act') {
    return { family: 'list', kind, rowId: row.id, name: row.name, answer: `${row.name} ${pastTense(spec.rowAction)}`,
      goal: rng.pick([`${capitalise(verb)} ${row.name} from the ${spec.heading.toLowerCase()} list.`, `Please ${verb} the ${row.name}.`]) }
  }
  if (kind === 'open') return { family: 'list', kind, rowId: row.id, name: row.name, answer: String(row.stock), goal: `Open ${row.name} and tell me how many are in stock.` }
  const read = rng.pick([
    { field: 'price', ask: `What is the price of the ${row.name}?`, answer: row.price },
    { field: 'status', ask: `What is the status of ${row.name}?`, answer: row.status },
    { field: 'SKU', ask: `Find the SKU for ${row.name}.`, answer: row.sku }
  ])
  return { family: 'list', kind, rowId: row.id, name: row.name, field: read.field, answer: read.answer, goal: read.ask }
}

const pastTense = (action) => ({ Delete: 'deleted', Remove: 'removed', Archive: 'archived' })[action]

function listPlan(spec, task, state) {
  const steps = []
  const row = spec.rows.find((r) => r.id === task.rowId)
  if (task.kind === 'missing' || !state.visibleRowIds.includes(row.id)) {
    steps.push({ title: `Find ${task.name}`, check: `row "${task.name}" is shown`, test: { type: 'rowShown', id: task.rowId } })
  }
  if (task.kind === 'act') {
    steps.push({ title: `Click ${spec.rowAction} for ${row.name}`, check: `dialog "${spec.rowAction} ${row.name}?"`, test: { type: 'dialogFor', id: row.id } })
    steps.push({ title: `Confirm ${spec.rowAction}`, check: `text "${task.answer}"`, test: { type: 'deleted', id: row.id } })
  } else if (task.kind === 'open') {
    steps.push({ title: `Open ${row.name}`, check: `text "${row.name}: ${row.stock} in stock"`, test: { type: 'opened', id: row.id } })
  } else if (task.kind === 'read') {
    steps.push({ title: `Read the ${task.field} of ${row.name}`, check: `row "${row.name}" shows the ${task.field}`, test: { type: 'rowShown', id: row.id } })
  }
  return steps
}

function listActions(spec, task, state) {
  const row = spec.rows.find((r) => r.id === task.rowId)
  if (state.dialogOpen) return task.kind === 'act' && state.pendingRow === row?.id ? [`click(@${spec.dialog.confirmId})`] : [`click(@${spec.dialog.cancelId})`]
  if (row && state.visibleRowIds.includes(row.id)) {
    if (task.kind === 'act') return [`click(@${row.actionId})`]
    if (task.kind === 'open') return [`click(@${row.openId})`]
    return []
  }
  return findActions(spec, task.name, state)
}

function findActions(spec, name, state) {
  const out = []
  if (spec.searchBox) {
    const typed = String(state.values[spec.searchBox.id] ?? '').trim().toLowerCase()
    if (typed && name.toLowerCase().includes(typed) && state.query !== typed) {
      if (state.focused === spec.searchBox.id) out.push(`press("Enter")`)
      out.push(`click(@${spec.searchBox.buttonId})`)
    }
    else if (state.query !== name.toLowerCase()) out.push(`type(@${spec.searchBox.id},${q(name)})`)
  }
  if (spec.paging && !state.query) {
    const index = matchingRows(spec, state).findIndex((r) => r.name === name)
    const page = index >= 0 ? Math.floor(index / spec.pageSize) : state.pageCount - 1
    if (page > state.page) out.push(`click(@${spec.paging.nextId})`)
    if (page < state.page) out.push(`click(@${spec.paging.prevId})`)
  }
  return out
}

const matchingRows = (spec, state) => spec.rows.filter((r) => !state.deleted.includes(r.id) && (!state.query || r.name.toLowerCase().includes(state.query)))

// ---------- bulk tasks (long) ----------

function bulkTask(spec, rng) {
  const present = [...new Set(spec.rows.map((r) => r.status))]
  const statuses = rng.sample(present, rng.chance(0.4) ? Math.min(2, present.length) : 1)
  const which = statuses.join(' or ')
  if (spec.editable) {
    const stock = String(rng.pick([0, 5, 10, 50]))
    return { family: 'bulk', kind: 'edit', statuses, stock, answer: `Stock set to ${stock} for every ${which} item`,
      goal: rng.pick([`Set the stock to ${stock} for every item with status ${which}, and save each one.`, `Change stock to ${stock} on all ${which} items.`]) }
  }
  const verb = spec.rowAction.toLowerCase()
  return { family: 'bulk', kind: 'act', statuses, answer: `Every ${which} item ${pastTense(spec.rowAction)}`,
    goal: rng.pick([`${capitalise(verb)} every item with status ${which}.`, `Please ${verb} all ${which} items in the list.`]) }
}

function bulkPlan(spec, task) {
  const which = task.statuses.join(' or ')
  if (task.kind === 'edit') return [{ title: `Set stock to ${task.stock} and save it for each ${which} item`, check: `no ${which} item has stock other than ${task.stock}`, test: { type: 'bulkDone' } }]
  return [{ title: `${spec.rowAction} each ${which} item and confirm`, check: `no ${which} item remains`, test: { type: 'bulkDone' } }]
}

const bulkPending = (spec, task, state) => spec.rows.filter((r) => task.statuses.includes(r.status) && !state.deleted.includes(r.id) &&
  (task.kind !== 'edit' || state.savedStock[r.id] !== task.stock))

function bulkActions(spec, task, state) {
  if (state.dialogOpen) {
    const pending = spec.rows.find((r) => r.id === state.pendingRow)
    return pending && task.statuses.includes(pending.status) ? [`click(@${spec.dialog.confirmId})`] : [`click(@${spec.dialog.cancelId})`]
  }
  const todo = bulkPending(spec, task, state)
  const shown = todo.filter((r) => state.visibleRowIds.includes(r.id))
  if (shown.length) {
    if (task.kind === 'edit') {
      return shown.map((r) => (state.stock[r.id] !== task.stock ? `type(@${r.stockId},${q(task.stock)})` : `click(@${r.saveId})`))
    }
    return shown.map((r) => `click(@${r.actionId})`)
  }
  if (!todo.length || !spec.paging) return []
  const rows = matchingRows(spec, state)
  const page = Math.floor(rows.findIndex((r) => r.id === todo[0].id) / spec.pageSize)
  return [page > state.page ? `click(@${spec.paging.nextId})` : `click(@${spec.paging.prevId})`]
}

// ---------- shared: plan, actions, verdicts ----------

/** The full plan the planner should return for this state, before any corrections. */
export function initialPlan(spec, task, state) {
  if (task.family === 'form' || task.family === 'wizard') return formPlan(spec, task, state)
  if (task.family === 'bulk') return bulkPlan(spec, task)
  return listPlan(spec, task, state)
}

/** What went off course: each issue becomes a re-plan reason and a correction step. */
export function issues(spec, task, state) {
  const found = []
  if (state.view === 'other') found.push({ reason: `left the task: the ${state.other} page is open`, step: { title: `Go back to the ${spec.heading} page`, check: `heading "${spec.heading}"`, test: { type: 'viewMain' } } })
  if (task.family === 'form' || task.family === 'wizard') {
    const targetIds = new Set(task.targets.map((t) => t.id))
    for (const { field } of fieldsOf(spec)) {
      if (targetIds.has(field.id) || !['text', 'email', 'tel', 'number', 'textarea'].includes(field.kind)) continue
      if ((state.values[field.id] ?? '') !== '') {
        found.push({ reason: `typed into the wrong field: ${field.label}`, step: { title: `Clear ${field.label}`, check: `textbox "${field.label}" is empty`, test: { type: 'value', id: field.id, value: '' } } })
      }
    }
  }
  return found
}

export function stepDone(step, state) {
  const t = step.test
  switch (t.type) {
    case 'value': return (state.values[t.id] ?? (typeof t.value === 'boolean' ? false : '')) === t.value
    case 'revealedOrDone': return state.visible.includes(t.field) || state.values[t.field] === t.value
    case 'wizardPage': return state.wizardPage >= t.page
    case 'sent': return state.submitted || Boolean(state.gate && state.gateAfter === 'submit') || state.locked
    case 'submitted': return state.submitted
    case 'gatePassed': return state.gatePassed || !state.gate
    case 'rowShown': return state.visibleRowIds.includes(t.id) || state.deleted.includes(t.id) || state.opened === t.id
    case 'dialogFor': return (state.dialogOpen && state.pendingRow === t.id) || state.deleted.includes(t.id)
    case 'deleted': return state.deleted.includes(t.id)
    case 'opened': return state.opened === t.id
    case 'viewMain': return state.view !== 'other'
    default: return false
  }
}

function goalDone(spec, task, state) {
  if (task.family === 'form' || task.family === 'wizard') return state.submitted && task.targets.every((t) => state.values[t.id] === t.value)
  if (task.family === 'bulk') return bulkPending(spec, task, state).length === 0
  if (task.kind === 'act') return state.deleted.includes(task.rowId)
  if (task.kind === 'open') return state.opened === task.rowId
  if (task.kind === 'read') return state.view === 'main' && state.visibleRowIds.includes(task.rowId)
  return false
}

function impossible(spec, task, state) {
  if (state.locked) return 'the account is locked'
  if (task.kind !== 'missing' || state.view !== 'main') return null
  const searched = spec.searchBox && state.query && task.name.toLowerCase().includes(state.query)
  if (searched && state.matchCount === 0) return `no item named ${task.name}`
  const lastPage = !state.query && state.page >= state.pageCount - 1
  if (!spec.searchBox && lastPage) return `no item named ${task.name} in the list`
  return null
}

const GATE_REASON = { login: 'sign in required', payment: 'payment details needed', captcha: 'security check needed' }

/**
 * The evaluator label. `plan` is the plan the actor is working from; corrections the plan
 * already holds do not cause another re-plan.
 */
export function verdict(spec, task, plan, state) {
  if (state.gate) return { verdict: `takeover(${q(GATE_REASON[state.gate])})` }
  const failure = impossible(spec, task, state)
  if (failure) return { verdict: `fail(${q(failure)})` }
  if (goalDone(spec, task, state)) return { verdict: `success(${q(task.answer)})` }
  const open = issues(spec, task, state).filter((issue) => !plan.some((step) => step.title === issue.step.title))
  if (open.length) return { verdict: `replan(${q(open[0].reason)})`, reason: open[0].reason }
  const current = plan.findIndex((step) => !stepDone(step, state)) + 1
  if (current === 0) {
    const reason = spec.family === 'wizard'
      ? `a new page is shown: step ${state.wizardPage + 1} of ${spec.pages.length}`
      : 'the plan is finished but the goal is not met'
    return { verdict: `replan(${q(reason)})`, reason }
  }
  return { verdict: `continue(${current})`, current }
}

/** The plan after a re-plan: finished steps kept, then corrections, then the steps still open. */
export function replan(spec, task, plan, state) {
  const done = plan.filter((step) => stepDone(step, state) && !issues(spec, task, state).some((i) => i.step.title === step.title))
  const fixes = issues(spec, task, state).map((issue) => issue.step)
  // Same step = same check, not same title: every wizard page has its own "Continue" step.
  const same = (a, b) => JSON.stringify(a.test) === JSON.stringify(b.test)
  const fresh = initialPlan(spec, task, state).filter((step) => !stepDone(step, state) && !done.some((d) => same(d, step)))
  return { done, remaining: [...fixes, ...fresh] }
}

/** Every correct next action, best first. Corrections come before task actions. */
export function correctActions(spec, task, state) {
  if (state.view === 'other') return ['click(@back)']
  if (task.family === 'form' || task.family === 'wizard') {
    const fixes = issues(spec, task, state).filter((i) => i.step.test.type === 'value').map((i) => [`clear(@${i.step.test.id})`, `type(@${i.step.test.id},"")`]).flat()
    if (fixes.length) return fixes
    return formActions(spec, task, state)
  }
  if (task.family === 'bulk') return bulkActions(spec, task, state)
  if (task.kind === 'missing') return findActions(spec, task.name, state)
  return listActions(spec, task, state)
}

function joinParts(parts, rng) {
  if (parts.length === 1) return parts[0]
  const joiner = rng.pick([', ', '; '])
  return `${parts.slice(0, -1).join(joiner)} and ${parts.at(-1)}`
}
