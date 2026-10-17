// CRM flow (HubSpot style): a deals board and a deals table, deal pages with a stage picker and
// notes, and contact pages with an Edit form.

import { esc, cookieSteps, flowStepDone } from './flows.mjs'
import { FIRST_NAMES, LAST_NAMES } from './vocab-pools.mjs'

const STAGES = ['Appointment scheduled', 'Qualified to buy', 'Presentation scheduled', 'Decision maker bought-in', 'Contract sent', 'Closed won', 'Closed lost']
const COMPANIES = ['Cedar Bank', 'Northwind Foods', 'Kite Logistics', 'BluePeak Insurance', 'Lumen Health', 'Orbit Travel', 'Harbor Retail', 'Pinecrest Capital', 'Quill Media', 'Acme Steel', 'Saffron Hotels', 'Monsoon Labs']
const DEAL_KINDS = ['Renewal', 'Expansion', 'Pilot', 'Annual plan', 'Upsell', 'New logo']
const TITLES = ['Head of IT', 'CTO', 'Procurement lead', 'VP Operations', 'Finance manager', 'CISO', 'Product lead']
const NOTES = ['Sent the revised quote.', 'Call went well, legal review next week.', 'Asked for a security questionnaire.', 'Budget approved for Q4.', 'Follow up after Diwali.', 'Wants a demo for the ops team.']
const FIELDS = ['Email', 'Phone', 'Job title']

function crmSpec(rng, base, id) {
  const companies = rng.sample(COMPANIES, rng.int(6, 10))
  const taken = new Set()
  const contacts = companies.map((company) => {
    let first, last
    do { first = rng.pick(FIRST_NAMES); last = rng.pick(LAST_NAMES) } while (taken.has(first + last))
    taken.add(first + last)
    return {
      id: id('ct'), linkId: id('cl'), editId: id('ce'), saveId: id('cs'), company, name: `${first} ${last}`,
      values: { Email: `${first.toLowerCase()}@${company.toLowerCase().replace(/[^a-z]+/g, '')}.example.com`, Phone: `9${rng.int(100000000, 999999999)}`, 'Job title': rng.pick(TITLES) },
      inputIds: Object.fromEntries(FIELDS.map((f) => [f, id('ci')]))
    }
  })
  const deals = []
  for (const c of contacts) {
    for (const kind of rng.sample(DEAL_KINDS, rng.int(1, 3))) {
      deals.push({ id: id('dl'), boardLinkId: id('db'), tableLinkId: id('dt'), stageId: id('ds'), noteId: id('dn'), saveNoteId: id('dv'), name: `${c.company} – ${kind}`, contactId: c.id, stage: rng.pick(STAGES), amount: rng.int(4, 120) * 25000, close: `${rng.int(1, 28)} ${rng.pick(['November', 'December', 'January', 'February'])} ${rng.pick([2026, 2027])}`, owner: `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}` })
    }
  }
  const spec = {
    ...base, start: 'deals', path: rng.pick(['/contacts/deals', '/crm/pipeline', '/sales/deals']), heading: 'Deals', stages: STAGES, deals, contacts,
    nav: [{ id: id('nv'), label: 'Deals', view: 'deals' }, { id: id('nv'), label: 'Contacts', view: 'contacts' }],
    boardTabId: id('tb'), tableTabId: id('tt'), backId: id('bk')
  }
  const steps = [...cookieSteps(spec)]
  const kind = rng.pick(['stage', 'stage', 'next', 'note', 'contact', 'close'])
  const viaTable = rng.chance(0.35)
  const openDeal = (d) => {
    if (viaTable) steps.push({ title: 'Switch to the Table view', check: 'tab "Table" selected', test: { type: 'picked', key: 'crmTab', value: 'table' }, view: 'deals', action: { kind: 'click', id: spec.tableTabId } })
    steps.push({ title: `Open ${d.name}`, check: `heading "${d.name}"`, test: { type: 'view', view: `deal-${d.id}` }, view: 'deals', action: { kind: 'click', id: viaTable ? d.tableLinkId : d.boardLinkId } })
  }
  const where = viaTable ? rng.pick(['In the deals table, ', 'Using the table view, ']) : ''
  if (kind === 'stage' || kind === 'next') {
    const pool = kind === 'next' ? deals.filter((d) => STAGES.indexOf(d.stage) < 5) : deals
    const d = rng.pick(pool)
    const stage = kind === 'next' ? STAGES[STAGES.indexOf(d.stage) + 1] : rng.pick(STAGES.filter((s) => s !== d.stage))
    openDeal(d)
    steps.push({ title: `Set the stage to ${stage}`, check: `combobox "Deal stage" = ${stage}`, test: { type: 'value', id: d.stageId, value: stage }, view: `deal-${d.id}`, action: { kind: 'select', id: d.stageId, value: stage } })
    const goal = kind === 'next'
      ? `${where}move the ${d.name} deal to the next stage.`
      : rng.pick([`${where}move the ${d.name} deal to ${stage}.`, `${where}set the stage of ${d.name} to "${stage}".`])
    return { spec, task: { family: 'crm', goal: cap(goal), steps, answer: `${d.name} is now in ${stage}`, done: { type: 'effect', key: `stage:${d.id}:${stage}` } } }
  }
  if (kind === 'note') {
    const d = rng.pick(deals); const text = rng.pick(NOTES)
    openDeal(d)
    steps.push({ title: 'Type the note', check: `textbox "Note" = ${text}`, test: { type: 'any', of: [{ type: 'value', id: d.noteId, value: text }, { type: 'effect', key: `note:${d.id}` }] }, view: `deal-${d.id}`, action: { kind: 'type', id: d.noteId, value: text } })
    steps.push({ title: 'Click Save note', check: 'text "Note saved"', test: { type: 'effect', key: `note:${d.id}` }, view: `deal-${d.id}`, action: { kind: 'click', id: d.saveNoteId } })
    return { spec, task: { family: 'crm', goal: cap(`${where}add a note to the ${d.name} deal: "${text}"`), steps, answer: `Note added to ${d.name}`, done: { type: 'effect', key: `note:${d.id}` } } }
  }
  if (kind === 'contact') {
    const c = rng.pick(contacts); const field = rng.pick(FIELDS)
    const value = field === 'Email' ? `${c.name.split(' ')[0].toLowerCase()}.${rng.int(1, 99)}@${c.company.toLowerCase().replace(/[^a-z]+/g, '')}.example.com` : field === 'Phone' ? `9${rng.int(100000000, 999999999)}` : rng.pick(TITLES.filter((t) => t !== c.values['Job title']))
    const key = `contact:${c.id}:${field}=${value}`
    const contactsNav = spec.nav[1]
    steps.push({ title: 'Open Contacts', check: 'heading "Contacts"', test: { type: 'view', view: 'contacts' }, view: '*', action: { kind: 'click', id: contactsNav.id } })
    steps.push({ title: `Open ${c.name}`, check: `heading "${c.name}"`, test: { type: 'view', view: `contact-${c.id}` }, view: 'contacts', action: { kind: 'click', id: c.linkId } })
    steps.push({ title: 'Click Edit contact', check: `textbox "${field}" = ${c.values[field]}`, test: { type: 'any', of: [{ type: 'visible', id: c.inputIds[field] }, { type: 'effect', key }] }, view: `contact-${c.id}`, action: { kind: 'click', id: c.editId } })
    steps.push({ title: `Set ${field} to ${value}`, check: `textbox "${field}" = ${value}`, test: { type: 'value', id: c.inputIds[field], value }, view: `contact-${c.id}`, action: { kind: 'type', id: c.inputIds[field], value } })
    steps.push({ title: 'Click Save', check: 'text "Contact updated"', test: { type: 'effect', key }, view: `contact-${c.id}`, action: { kind: 'click', id: c.saveId } })
    const goal = rng.pick([`Change the ${field.toLowerCase()} of ${c.name} to ${value}.`, `Update ${c.name}'s ${field.toLowerCase()} to ${value} in the CRM.`])
    return { spec, task: { family: 'crm', goal, steps, answer: `${c.name}'s ${field.toLowerCase()} is now ${value}`, done: { type: 'effect', key } } }
  }
  const d = rng.pick(deals)
  openDeal(d)
  return { spec, task: { family: 'crm', goal: cap(`${where}when is the ${d.name} deal expected to close?`), steps, answer: d.close, done: { type: 'view', view: `deal-${d.id}` } } }
}

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1)
const inr = (n) => `₹${n.toLocaleString('en-IN')}`

function renderCrm(spec) {
  const contact = (id) => spec.contacts.find((c) => c.id === id)
  const card = (d) => `<div class="deal" data-deal-card="${d.id}"><a href="#" data-gen-id="${d.boardLinkId}" data-goto="deal-${d.id}">${esc(d.name)}</a><br><small>${inr(d.amount)} · ${esc(d.owner)}</small></div>`
  const board = `<div class="board" data-crm-board>${spec.stages.map((s) => `<section class="col" role="region" aria-label="${esc(s)}" data-stage-col="${esc(s)}"><h3>${esc(s)}</h3>${spec.deals.filter((d) => d.stage === s).map(card).join('')}</section>`).join('')}</div>`
  const table = `<table data-crm-table hidden><thead><tr><th>Deal name</th><th>Deal stage</th><th>Amount</th><th>Close date</th><th>Deal owner</th></tr></thead><tbody>${spec.deals.map((d) => `<tr><td><a href="#" data-gen-id="${d.tableLinkId}" data-goto="deal-${d.id}">${esc(d.name)}</a></td><td data-stage-cell="${d.id}">${esc(d.stage)}</td><td>${inr(d.amount)}</td><td>${esc(d.close)}</td><td>${esc(d.owner)}</td></tr>`).join('')}</tbody></table>`
  const dealPage = (d) => { const c = contact(d.contactId); return `<section data-view="deal-${d.id}" hidden><h1>${esc(d.name)}</h1>
    <p><label>Deal stage <select data-gen-id="${d.stageId}" aria-label="Deal stage" data-stage-select="${d.id}">${spec.stages.map((s) => `<option${s === d.stage ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label></p>
    <dl><dt>Amount</dt><dd>${inr(d.amount)}</dd><dt>Close date</dt><dd>${esc(d.close)}</dd><dt>Deal owner</dt><dd>${esc(d.owner)}</dd><dt>Contact</dt><dd><a href="#" data-goto="contact-${c.id}">${esc(c.name)}</a></dd></dl>
    <h2>Activity</h2><textarea data-gen-id="${d.noteId}" aria-label="Note" placeholder="Start typing to leave a note…"></textarea><br><button data-gen-id="${d.saveNoteId}" data-save-note="${d.id}">Save note</button><ul data-timeline="${d.id}"><li>Deal created</li></ul></section>` }
  const contactPage = (c) => `<section data-view="contact-${c.id}" hidden><h1>${esc(c.name)}</h1><p>${esc(c.company)}</p>
    <dl>${FIELDS.map((f) => `<dt>${f}</dt><dd data-contact-show="${c.id}:${f}">${esc(c.values[f])}</dd>`).join('')}</dl>
    <button class="ghost" data-gen-id="${c.editId}" data-edit-contact="${c.id}" aria-label="Edit contact">Edit</button>
    <div data-contact-form="${c.id}" hidden>${FIELDS.map((f) => `<label>${f} <input data-gen-id="${c.inputIds[f]}" aria-label="${f}" value="${esc(c.values[f])}"></label><br>`).join('')}<button data-gen-id="${c.saveId}" data-save-contact="${c.id}">Save</button></div></section>`
  return {
    header: `<nav aria-label="CRM">${spec.nav.map((n) => `<a href="#" data-gen-id="${n.id}" data-goto="${n.view}">${n.label}</a>`).join(' · ')}</nav>`,
    views: `<section data-view="deals"><h1>Deals</h1><div role="tablist"><button role="tab" class="ghost" data-gen-id="${spec.boardTabId}" data-crm-tab="board" aria-selected="true">Board</button><button role="tab" class="ghost" data-gen-id="${spec.tableTabId}" data-crm-tab="table" aria-selected="false">Table</button></div>${board}${table}</section>
    <section data-view="contacts" hidden><h1>Contacts</h1><table><thead><tr><th>Name</th><th>Company</th><th>Email</th></tr></thead><tbody>${spec.contacts.map((c) => `<tr><td><a href="#" data-gen-id="${c.linkId}" data-goto="contact-${c.id}">${esc(c.name)}</a></td><td>${esc(c.company)}</td><td data-contact-show="${c.id}:Email">${esc(c.values.Email)}</td></tr>`).join('')}</tbody></table></section>
    ${spec.deals.map(dealPage).join('')}${spec.contacts.map(contactPage).join('')}`
  }
}

const css = `
  .board{display:flex;gap:10px;overflow-x:auto} .col{min-width:170px;background:#f5f6f8;padding:8px}
  .deal{background:#fff;border:1px solid #ddd;padding:8px;margin:6px 0} table{border-collapse:collapse} td,th{border-bottom:1px solid #eee;padding:6px 10px;text-align:left}`

const runtime = String.raw`
;(() => {
  const { st, status, $, $$ } = window.__ogx
  const spec = window.__SPEC
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button,a'); if (!el) return
    if (el.dataset.crmTab) {
      st.picked.crmTab = el.dataset.crmTab
      $$('[data-crm-tab]').forEach((b) => b.setAttribute('aria-selected', String(b === el)))
      $('[data-crm-board]').hidden = el.dataset.crmTab !== 'board'; $('[data-crm-table]').hidden = el.dataset.crmTab !== 'table'
      return
    }
    if (el.dataset.saveNote) {
      const box = $('[data-gen-id="' + spec.deals.find((d) => d.id === el.dataset.saveNote).noteId + '"]')
      const text = box.value.trim(); if (!text) { status('Write a note first.'); return }
      st.effects['note:' + el.dataset.saveNote] = true
      const li = document.createElement('li'); li.textContent = 'Note: ' + text; $('[data-timeline="' + el.dataset.saveNote + '"]').prepend(li)
      box.value = ''; status('Note saved.'); return
    }
    if (el.dataset.editContact) { $('[data-contact-form="' + el.dataset.editContact + '"]').hidden = false; return }
    if (el.dataset.saveContact) {
      const c = spec.contacts.find((x) => x.id === el.dataset.saveContact)
      for (const f of Object.keys(c.inputIds)) {
        const v = $('[data-gen-id="' + c.inputIds[f] + '"]').value.trim()
        if (v !== c.values[f]) { st.effects['contact:' + c.id + ':' + f + '=' + v] = true; c.values[f] = v; $$('[data-contact-show="' + c.id + ':' + f + '"]').forEach((d) => (d.textContent = v)) }
      }
      $('[data-contact-form="' + c.id + '"]').hidden = true; status('Contact updated.'); return
    }
  })
  document.addEventListener('change', (e) => {
    const id = e.target.dataset && e.target.dataset.stageSelect; if (!id) return
    const stage = e.target.value
    st.effects['stage:' + id + ':' + stage] = true
    $('[data-stage-col="' + CSS.escape(stage) + '"]').appendChild($('[data-deal-card="' + id + '"]'))
    $('[data-stage-cell="' + id + '"]').textContent = stage
    const li = document.createElement('li'); li.textContent = 'Stage changed to ' + stage; $('[data-timeline="' + id + '"]').prepend(li)
    status('Deal stage updated.')
  })
})()`

function done(t, state) {
  if (t.type === 'any') return t.of.some((test) => flowStepDone({ test }, state))
  return false
}

export const crmFlow = { spec: crmSpec, render: renderCrm, css, runtime, done }
