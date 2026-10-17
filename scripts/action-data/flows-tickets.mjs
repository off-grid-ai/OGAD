// Ticket board flow (Jira / Trello style): columns of cards. A card moves by drag and drop or by
// its "Move to" menu; a card page sets the assignee and the status.

import { esc, cookieSteps } from './flows.mjs'
import { FIRST_NAMES, LAST_NAMES } from './vocab-pools.mjs'

const BOARDS = [
  { cols: ['To do', 'In progress', 'In review', 'Done'], project: 'PAY' },
  { cols: ['Backlog', 'Doing', 'Review', 'Done'], project: 'WEB' },
  { cols: ['Open', 'In progress', 'Blocked', 'Closed'], project: 'OPS' },
  { cols: ['To do', 'In progress', 'QA', 'Done'], project: 'APP' }
]
const SUMMARIES = ['Fix login redirect loop', 'Add UPI autopay option', 'Update invoice PDF layout', 'Rate limit the OTP endpoint', 'Migrate cron jobs to queue', 'Dark mode for settings', 'Crash on Android 14 share sheet', 'Write onboarding emails', 'Audit S3 bucket policies', 'Speed up search index', 'Add CSV export to reports', 'Broken link in footer', 'Refund flow for partial orders', 'Translate checkout to Hindi', 'Remove unused feature flags', 'Alert on failed payouts', 'Cache exchange rates', 'Accessibility pass on forms', 'Retry webhook deliveries', 'Clean up old staging data']

function ticketsSpec(rng, base, id) {
  const board = rng.pick(BOARDS)
  const people = []
  while (people.length < 5) { const p = `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`; if (!people.includes(p)) people.push(p) }
  const start = rng.int(10, 300)
  const cards = rng.sample(SUMMARIES, rng.int(8, 16)).map((summary, i) => ({
    id: id('tk'), btnId: id('tb'), menuId: id('tm'), statusId: id('ts'), assigneeId: id('ta'),
    key: `${board.project}-${start + i}`, summary, col: rng.pick(board.cols), assignee: rng.chance(0.3) ? 'Unassigned' : rng.pick(people)
  }))
  const spec = {
    ...base, start: 'board', path: rng.pick(['/jira/software/projects/board', '/b/sprint-board', '/boards/1']), heading: `${board.project} board`,
    cols: board.cols.map((name) => ({ name, id: id('co'), moveId: id('mv') })), cards, people, backId: id('bk')
  }
  const steps = [...cookieSteps(spec)]
  const c = rng.pick(cards)
  const label = `${c.key} ${c.summary}`
  const kind = rng.pick(['move', 'move', 'assign', 'status', 'both'])
  const open = () => steps.push({ title: `Open ${c.key}`, check: `heading "${label}"`, test: { type: 'view', view: `card-${c.id}` }, view: 'board', action: { kind: 'click', id: c.btnId } })
  if (kind === 'move') {
    const col = rng.pick(board.cols.filter((x) => x !== c.col))
    steps.push({ title: `Move ${c.key} to ${col}`, check: `card "${c.key}" in ${col}`, test: { type: 'inCol', card: c.id, col }, view: 'board', action: { kind: 'move', card: c.id, col } })
    const goal = rng.pick([`Move ${c.key} to ${col}.`, `Drag the "${c.summary}" card to ${col}.`, `On the ${board.project} board, put "${c.summary}" in the ${col} column.`])
    return { spec, task: { family: 'tickets', goal, steps, answer: `${c.key} is in ${col}`, done: { type: 'inCol', card: c.id, col } } }
  }
  const who = rng.pick([...people, 'Unassigned'].filter((p) => p !== c.assignee))
  const col = rng.pick(board.cols.filter((x) => x !== c.col))
  open()
  if (kind === 'assign' || kind === 'both') steps.push({ title: `Set Assignee to ${who}`, check: `combobox "Assignee" = ${who}`, test: { type: 'value', id: c.assigneeId, value: who }, view: `card-${c.id}`, action: { kind: 'select', id: c.assigneeId, value: who } })
  if (kind === 'status' || kind === 'both') steps.push({ title: `Set Status to ${col}`, check: `combobox "Status" = ${col}`, test: { type: 'value', id: c.statusId, value: col }, view: `card-${c.id}`, action: { kind: 'select', id: c.statusId, value: col } })
  const assignGoal = who === 'Unassigned' ? `unassign ${c.key}` : `assign ${c.key} to ${who}`
  const goal = kind === 'assign' ? cap(`${assignGoal}.`) : kind === 'status' ? rng.pick([`Set the status of ${c.key} to ${col}.`, `Mark "${c.summary}" as ${col}.`]) : cap(`${assignGoal} and set its status to ${col}.`)
  const keys = [...(kind !== 'status' ? [`assign:${c.id}:${who}`] : []), ...(kind !== 'assign' ? [`status:${c.id}:${col}`] : [])]
  return { spec, task: { family: 'tickets', goal, steps, answer: kind === 'assign' ? `${c.key} assigned to ${who}` : kind === 'status' ? `${c.key} is ${col}` : `${c.key}: ${who}, ${col}`, done: { type: 'effects', keys } } }
}

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1)

function renderTickets(spec) {
  const card = (c) => `<div class="tk" data-card-wrap="${c.id}"><button class="ghost tkb" data-gen-id="${c.btnId}" data-card="${c.id}" data-goto="card-${c.id}">${esc(c.key)} ${esc(c.summary)}</button><button class="ghost tkm" data-gen-id="${c.menuId}" data-card-menu="${c.id}" aria-label="Actions for ${esc(c.key)}">⋯</button><br><small data-card-assignee="${c.id}">${esc(c.assignee)}</small></div>`
  const page = (c) => `<section data-view="card-${c.id}" hidden><h1>${esc(c.key)} ${esc(c.summary)}</h1>
    <label>Status <select data-gen-id="${c.statusId}" aria-label="Status" data-card-status="${c.id}">${spec.cols.map((x) => `<option${x.name === c.col ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
    <label>Assignee <select data-gen-id="${c.assigneeId}" aria-label="Assignee" data-card-assign="${c.id}">${['Unassigned', ...spec.people].map((p) => `<option${p === c.assignee ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
    <h2>Description</h2><p>${esc(c.summary)}. Steps and acceptance criteria are in the linked doc.</p></section>`
  return {
    views: `<section data-view="board"><h1>${esc(spec.heading)}</h1><div class="cols">${spec.cols.map((x) => `<section class="tcol" role="group" aria-label="${esc(x.name)}" data-gen-id="${x.id}" data-col="${esc(x.name)}"><h2>${esc(x.name)}</h2>${spec.cards.filter((c) => c.col === x.name).map(card).join('')}</section>`).join('')}</div>
      <div role="menu" aria-label="Card actions" class="menu tmenu" data-card-menu-list hidden>${spec.cols.map((x) => `<button role="menuitem" class="ghost" data-gen-id="${x.moveId}" data-move-to="${esc(x.name)}">Move to ${esc(x.name)}</button>`).join('')}</div></section>
    ${spec.cards.map(page).join('')}`
  }
}

const css = `
  .cols{display:flex;gap:10px;align-items:flex-start} .tcol{flex:1;min-width:180px;min-height:300px;background:#f4f5f7;padding:8px}
  .tk{background:#fff;border:1px solid #ddd;padding:6px;margin:6px 0;user-select:none} .tkb{border:0;text-align:left;padding:2px;width:85%} .tkm{border:0;padding:0 6px}
  .tmenu{position:absolute;background:#fff;border:1px solid #ccc;display:flex;flex-direction:column;z-index:4}`

const runtime = String.raw`
;(() => {
  const { st, status, $, $$ } = window.__ogx
  const spec = window.__SPEC
  for (const c of spec.cards) st.picked['col:' + c.id] = c.col
  const menu = $('[data-card-menu-list]')
  function closeMenu() { st.cardMenu = null; menu.hidden = true }
  function move(id, col) {
    if (st.picked['col:' + id] === col) return
    st.picked['col:' + id] = col
    $('[data-col="' + CSS.escape(col) + '"]').appendChild($('[data-card-wrap="' + id + '"]'))
    $('[data-card-status="' + id + '"]').value = col
    st.effects['status:' + id + ':' + col] = true
    status(spec.cards.find((c) => c.id === id).key + ' moved to ' + col + '.')
  }
  // Drag and drop with the mouse: press on a card, release over another column.
  let dragging = null
  document.addEventListener('mousedown', (e) => { const b = e.target.closest('[data-card]'); dragging = b ? b.dataset.card : null })
  document.addEventListener('mouseup', (e) => {
    const id = dragging; dragging = null; if (!id) return
    const col = e.target.closest('[data-col]'); if (!col) return
    if (col.dataset.col !== st.picked['col:' + id]) { closeMenu(); move(id, col.dataset.col) }
  })
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button'); if (!el) return
    if (el.dataset.cardMenu) {
      if (st.cardMenu === el.dataset.cardMenu) { closeMenu(); return }
      st.cardMenu = el.dataset.cardMenu; menu.hidden = false
      menu.querySelectorAll('[data-move-to]').forEach((b) => (b.hidden = b.dataset.moveTo === st.picked['col:' + st.cardMenu]))
      const r = el.getBoundingClientRect(); menu.style.left = r.left + window.scrollX + 'px'; menu.style.top = r.bottom + window.scrollY + 'px'
      return
    }
    if (el.dataset.moveTo) { const id = st.cardMenu; closeMenu(); move(id, el.dataset.moveTo); return }
    if (el.dataset.card) closeMenu()
  })
  document.addEventListener('change', (e) => {
    const t = e.target
    if (t.dataset.cardStatus) { move(t.dataset.cardStatus, t.value); return }
    if (t.dataset.cardAssign) {
      const id = t.dataset.cardAssign
      for (const k of Object.keys(st.effects)) if (k.startsWith('assign:' + id + ':')) delete st.effects[k]
      st.effects['assign:' + id + ':' + t.value] = true
      $('[data-card-assignee="' + id + '"]').textContent = t.value
      status(spec.cards.find((c) => c.id === id).key + ' assigned to ' + t.value + '.')
    }
  })
})()`

function done(t, state) {
  if (t.type === 'inCol') return state.picked[`col:${t.card}`] === t.col
  return false
}

/** Drag the card onto the column, or open its menu and pick "Move to". */
function actions(spec, a, state) {
  if (a.kind !== 'move') return []
  const c = spec.cards.find((x) => x.id === a.card)
  const col = spec.cols.find((x) => x.name === a.col)
  if (state.cardMenu === c.id) return [`click(@${col.moveId})`]
  return [`drag(@${c.btnId},@${col.id})`, `click(@${c.menuId})`]
}

export const ticketsFlow = { spec: ticketsSpec, render: renderTickets, css, runtime, done, actions }
