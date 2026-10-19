// Calendar flow (Google Calendar style): a week grid, create an event (title, date, time,
// guests), reschedule an own event, answer an invitation. Sending invitations to guests needs the
// user (takeover).

import { esc, cookieSteps, flowStepDone } from './flows.mjs'
import { FIRST_NAMES, LAST_NAMES } from './vocab-pools.mjs'

const DAYS = ['Mon 19 Oct', 'Tue 20 Oct', 'Wed 21 Oct', 'Thu 22 Oct', 'Fri 23 Oct', 'Sat 24 Oct', 'Sun 25 Oct']
const DAY_NAMES = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' }
// 8:00 AM to 8:00 PM, every 30 minutes.
const TIMES = Array.from({ length: 25 }, (_, i) => { const h = 8 + Math.floor(i / 2); const m = i % 2 ? '30' : '00'; return `${h > 12 ? h - 12 : h}:${m} ${h >= 12 ? 'PM' : 'AM'}` })
const TITLES = ['Standup', 'Design review', 'Sprint planning', '1:1 with manager', 'Client call', 'Lunch with team', 'Dentist', 'Gym', 'Budget review', 'Interview loop', 'Board prep', 'Product demo', 'Retro', 'Vendor sync', 'Yoga class', 'Parent-teacher meeting']
const NEW_TITLES = ['Quarterly planning', 'Coffee with Rohan', 'Roadmap review', 'Hiring sync', 'Bank visit', 'Customer onboarding', 'Team offsite prep', 'Launch rehearsal']

function calendarSpec(rng, base, id) {
  const people = Array.from({ length: 6 }, () => { const f = rng.pick(FIRST_NAMES); const l = rng.pick(LAST_NAMES); return { name: `${f} ${l}`, email: `${f.toLowerCase()}.${l.toLowerCase()}@example.com` } })
  // Events on the same day never overlap, so every chip can be clicked.
  const busy = []
  const free = (day, start, end, skip = null) => !busy.some((b) => b !== skip && b.day === day && start < b.end && b.start < end)
  const events = rng.sample(TITLES, rng.int(7, 13)).map((title) => {
    let day, start, len, tries = 0
    do { day = rng.pick(DAYS.slice(0, 5)); start = rng.int(0, 20); len = rng.int(1, 4) } while (!free(day, start, Math.min(24, start + len)) && ++tries < 50)
    const slot = { day, start, end: Math.min(24, start + len) }
    busy.push(slot)
    const invite = rng.chance(0.35)
    return {
      id: id('ev'), openId: id('eo'), editId: id('ee'), title, day, start, end: slot.end, slot,
      organizer: invite ? rng.pick(people).name : 'You', guests: invite || rng.chance(0.4) ? rng.sample(people, rng.int(1, 3)).map((p) => p.email) : [],
      rsvp: Object.fromEntries(['Yes', 'No', 'Maybe'].map((a) => [a, id('rv')])),
      form: { dateId: id('ed'), startId: id('es'), endId: id('en'), saveId: id('sv') }
    }
  })
  const spec = {
    ...base, start: 'week', path: rng.pick(['/calendar/r/week', '/calendar', '/cal/week']), heading: 'Calendar', days: DAYS, times: TIMES, events,
    createId: id('cr'), form: { titleId: id('ft'), dateId: id('fd'), startId: id('fs'), endId: id('fe'), guestsId: id('fg'), saveId: id('fv') },
    dialog: { sendId: id('ds'), skipId: id('dk') }, backId: id('bk'), todayId: id('td')
  }
  const steps = [...cookieSteps(spec)]
  const f = spec.form
  const timeSteps = (form, day, start, end, view) => [
    { title: `Set the date to ${day}`, check: `combobox "Date" = ${day}`, test: { type: 'value', id: form.dateId, value: day }, view, action: { kind: 'select', id: form.dateId, value: day } },
    { title: `Set the start time to ${TIMES[start]}`, check: `combobox "Start time" = ${TIMES[start]}`, test: { type: 'value', id: form.startId, value: TIMES[start] }, view, action: { kind: 'select', id: form.startId, value: TIMES[start] } },
    { title: `Set the end time to ${TIMES[end]}`, check: `combobox "End time" = ${TIMES[end]}`, test: { type: 'value', id: form.endId, value: TIMES[end] }, view, action: { kind: 'select', id: form.endId, value: TIMES[end] } }
  ]
  // Save, then (with guests) the "Send invitations?" dialog, whose Send button is the gate.
  const saveSteps = (saveId, view, key, guests) => guests
    ? [
        { title: 'Click Save', check: 'heading "Send invitation emails to guests?"', test: { type: 'any', of: [{ type: 'dialogOrEffect', key }, { type: 'gate', gate: 'send' }] }, view, action: { kind: 'click', id: saveId } },
        { title: 'Click Send', check: 'text "Sending invitations"', test: { type: 'gate', gate: 'send' }, view, action: { kind: 'click', id: spec.dialog.sendId } }
      ]
    : [{ title: 'Click Save', check: 'text "Event saved"', test: { type: 'effect', key }, view, action: { kind: 'click', id: saveId } }]
  const long = (day) => `${DAY_NAMES[day.slice(0, 3)]} ${day.slice(4)}`
  const kind = rng.pick(['create', 'create', 'invite', 'move', 'rsvp'])
  if (kind === 'create' || kind === 'invite') {
    const title = rng.pick(NEW_TITLES); const day = rng.pick(DAYS); const start = rng.int(0, 21); const end = Math.min(24, start + rng.int(1, 3))
    const guests = kind === 'invite' ? rng.sample(people, rng.int(1, 3)).map((p) => p.email) : []
    const key = `event:${title}`
    steps.push({ title: 'Click Create', check: 'heading "New event"', test: { type: 'view', view: 'new-event' }, view: 'week', action: { kind: 'click', id: spec.createId } })
    steps.push({ title: `Set the title to ${title}`, check: `textbox "Title" = ${title}`, test: { type: 'value', id: f.titleId, value: title }, view: 'new-event', action: { kind: 'type', id: f.titleId, value: title } })
    steps.push(...timeSteps(f, day, start, end, 'new-event'))
    if (guests.length) steps.push({ title: `Add guests ${guests.join(', ')}`, check: `textbox "Guests" = ${guests.join(', ')}`, test: { type: 'value', id: f.guestsId, value: guests.join(', ') }, view: 'new-event', action: { kind: 'type', id: f.guestsId, value: guests.join(', ') } })
    steps.push(...saveSteps(f.saveId, 'new-event', key, guests.length))
    const goal = guests.length
      ? rng.pick([`Create "${title}" on ${long(day)} from ${TIMES[start]} to ${TIMES[end]} and invite ${guests.join(', ')}.`, `Set up a meeting "${title}" on ${long(day)}, ${TIMES[start]}–${TIMES[end]}, with ${guests.join(' and ')}.`])
      : rng.pick([`Add "${title}" to my calendar on ${long(day)} from ${TIMES[start]} to ${TIMES[end]}.`, `Block ${TIMES[start]} to ${TIMES[end]} on ${long(day)} for "${title}".`])
    return { spec, task: { family: 'calendar', goal, steps, answer: `${title} on ${day}, ${TIMES[start]}–${TIMES[end]}`, done: guests.length ? { type: 'gatePassed', gate: 'send' } : { type: 'effect', key } } }
  }
  if (kind === 'move') {
    const ev = rng.pick(events.filter((e) => e.organizer === 'You'))
    if (!ev) return calendarSpec(rng, base, id)
    const len = ev.end - ev.start
    let day, start
    let tries = 0
    do { day = rng.pick(DAYS.slice(0, 5)); start = rng.int(0, 24 - len) } while (((day === ev.day && start === ev.start) || !free(day, start, start + len, ev.slot)) && ++tries < 100)
    if (tries >= 100) return calendarSpec(rng, base, id)
    const key = `moved:${ev.id}:${day} ${TIMES[start]}`
    steps.push({ title: `Open ${ev.title}`, check: `heading "${ev.title}"`, test: { type: 'view', view: `ev-${ev.id}` }, view: 'week', action: { kind: 'click', id: ev.openId } })
    steps.push({ title: 'Click Edit event', check: `heading "Edit ${ev.title}"`, test: { type: 'view', view: `edit-${ev.id}` }, view: `ev-${ev.id}`, action: { kind: 'click', id: ev.editId } })
    steps.push(...timeSteps(ev.form, day, start, start + len, `edit-${ev.id}`))
    steps.push(...saveSteps(ev.form.saveId, `edit-${ev.id}`, key, ev.guests.length))
    const goal = rng.pick([`Move ${ev.title} to ${long(day)} at ${TIMES[start]}, same length.`, `Reschedule "${ev.title}" to ${long(day)}, ${TIMES[start]} to ${TIMES[start + len]}.`])
    return { spec, task: { family: 'calendar', goal, steps, answer: `${ev.title} moved to ${day} ${TIMES[start]}`, done: ev.guests.length ? { type: 'gatePassed', gate: 'send' } : { type: 'effect', key } } }
  }
  const ev = rng.pick(events.filter((e) => e.organizer !== 'You'))
  if (!ev) return calendarSpec(rng, base, id)
  const answer = rng.pick(['No', 'No', 'Yes', 'Maybe'])
  const word = { No: 'Decline', Yes: 'Accept', Maybe: 'Answer maybe to' }[answer]
  const shown = { No: 'You declined', Yes: 'You are going', Maybe: 'You might go' }[answer]
  steps.push({ title: `Open ${ev.title}`, check: `heading "${ev.title}"`, test: { type: 'view', view: `ev-${ev.id}` }, view: 'week', action: { kind: 'click', id: ev.openId } })
  steps.push({ title: `Click ${answer}`, check: `text "${shown}"`, test: { type: 'effect', key: `rsvp:${ev.id}:${answer}` }, view: `ev-${ev.id}`, action: { kind: 'click', id: ev.rsvp[answer] } })
  return { spec, task: { family: 'calendar', goal: `${word} ${ev.organizer}'s invitation "${ev.title}" on ${long(ev.day)}.`, steps, answer: `${shown}: ${ev.title}`, done: { type: 'effect', key: `rsvp:${ev.id}:${answer}` } } }
}

function renderCalendar(spec) {
  const T = spec.times
  const opts = (list, selected) => list.map((o) => `<option${o === selected ? ' selected' : ''}>${esc(o)}</option>`).join('')
  const timeFields = (form, ev) => `<label>Date <select data-gen-id="${form.dateId}" aria-label="Date">${opts(spec.days, ev ? ev.day : spec.days[0])}</select></label>
    <label>Start time <select data-gen-id="${form.startId}" aria-label="Start time">${opts(T, ev ? T[ev.start] : T[2])}</select></label>
    <label>End time <select data-gen-id="${form.endId}" aria-label="End time">${opts(T, ev ? T[ev.end] : T[4])}</select></label>`
  const chip = (e) => `<button class="ev" data-gen-id="${e.openId}" data-goto="ev-${e.id}" data-ev-chip="${e.id}" style="grid-column:${spec.days.indexOf(e.day) + 2};grid-row:${e.start + 2} / ${e.end + 2}">${esc(e.title)}, ${esc(e.day)}, ${T[e.start]}</button>`
  const grid = `<div class="week" data-week>${spec.days.map((d, i) => `<div class="dh" style="grid-column:${i + 2};grid-row:1">${esc(d)}</div>`).join('')}${T.slice(0, 24).map((t, i) => `<div class="hr" style="grid-row:${i + 2}">${i % 2 ? '' : t}</div>`).join('')}${spec.events.map(chip).join('')}</div>`
  const eventPage = (e) => `<section data-view="ev-${e.id}" hidden><h1>${esc(e.title)}</h1><p data-ev-when="${e.id}">${esc(e.day)} · ${T[e.start]} – ${T[e.end]}</p><p>Organizer: ${esc(e.organizer)}</p>${e.guests.length ? `<p>Guests: ${e.guests.map(esc).join(', ')}</p>` : ''}
    ${e.organizer === 'You' ? `<button class="ghost" data-gen-id="${e.editId}" data-goto="edit-${e.id}">Edit event</button>` : `<div role="group" aria-label="Going?"><span>Going?</span> ${Object.entries(e.rsvp).map(([a, gid]) => `<button class="ghost" data-gen-id="${gid}" data-rsvp="${e.id}:${a}" aria-pressed="false">${a}</button>`).join(' ')}</div><p data-rsvp-note="${e.id}"></p>`}</section>`
  const editPage = (e) => e.organizer !== 'You' ? '' : `<section data-view="edit-${e.id}" hidden><h1>Edit ${esc(e.title)}</h1>${timeFields(e.form, e)}<br><button data-gen-id="${e.form.saveId}" data-cal-save="${e.id}">Save</button></section>`
  const f = spec.form
  return {
    header: `<button class="ghost" data-gen-id="${spec.todayId}">Today</button><span>October 2026</span>`,
    views: `<section data-view="week"><h1>Week of 19 October 2026</h1><button data-gen-id="${spec.createId}" data-goto="new-event">Create</button>${grid}</section>
    <section data-view="new-event" hidden><h1>New event</h1><label>Title <input data-gen-id="${f.titleId}" aria-label="Title" placeholder="Add title"></label><br>${timeFields(f, null)}<br>
      <label>Guests <input data-gen-id="${f.guestsId}" aria-label="Guests" placeholder="Add guests (emails, comma separated)"></label><br><button data-gen-id="${f.saveId}" data-cal-save="new">Save</button></section>
    ${spec.events.map(eventPage).join('')}${spec.events.map(editPage).join('')}
    <div class="banner" role="dialog" aria-label="Send invitations" data-cal-dialog hidden><h2>Send invitation emails to guests?</h2><button class="ghost" data-gen-id="${spec.dialog.skipId}" data-cal-skip>Don't send</button><button data-gen-id="${spec.dialog.sendId}" data-gate="send" data-cal-send>Send</button></div>`
  }
}

const css = `
  .week{display:grid;grid-template-columns:70px repeat(7,1fr);grid-auto-rows:22px;gap:1px;background:#eee;margin-top:10px}
  .dh,.hr{background:#fff;font-size:12px;padding:2px} .hr{grid-column:1} .ev{font-size:11px;padding:2px 4px;text-align:left;overflow:hidden}`

const runtime = String.raw`
;(() => {
  const { st, show, status, $ } = window.__ogx
  const spec = window.__SPEC
  const T = spec.times
  const val = (gid) => $('[data-gen-id="' + gid + '"]').value
  let pending = null
  function commit() {
    const p = pending; pending = null
    if (!p) return
    st.effects[p.key] = true
    let chip = p.ev ? $('[data-ev-chip="' + p.ev.id + '"]') : null
    if (!chip) { chip = document.createElement('button'); chip.className = 'ev'; $('[data-week]').appendChild(chip) }
    chip.textContent = p.title + ', ' + p.day + ', ' + T[p.start]
    chip.style.gridColumn = String(spec.days.indexOf(p.day) + 2); chip.style.gridRow = (p.start + 2) + ' / ' + (p.end + 2)
    if (p.ev) $('[data-ev-when="' + p.ev.id + '"]').textContent = p.day + ' · ' + T[p.start] + ' – ' + T[p.end]
    show('week')
  }
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button,a'); if (!el) return
    if (el.dataset.calSave) {
      const isNew = el.dataset.calSave === 'new'
      const ev = isNew ? null : spec.events.find((x) => x.id === el.dataset.calSave)
      const form = isNew ? spec.form : ev.form
      const title = isNew ? val(form.titleId).trim() : ev.title
      const day = val(form.dateId); const start = T.indexOf(val(form.startId)); const end = T.indexOf(val(form.endId))
      if (!title) { status('Add a title.'); return }
      if (end <= start) { status('End time must be after start time.'); return }
      const guests = isNew ? val(form.guestsId).split(',').map((g) => g.trim()).filter(Boolean) : ev.guests
      pending = { ev, title, day, start, end, key: isNew ? 'event:' + title : 'moved:' + ev.id + ':' + day + ' ' + T[start] }
      if (guests.length) { st.dialogOpen = true; $('[data-cal-dialog]').hidden = false; return }
      commit(); status('Event saved.'); return
    }
    if (el.dataset.calSkip !== undefined) { st.dialogOpen = false; $('[data-cal-dialog]').hidden = true; commit(); status('Event saved. Guests were not told.'); return }
    if (el.dataset.calSend !== undefined) { st.dialogOpen = false; $('[data-cal-dialog]').hidden = true; commit(); status('Sending invitations…'); return }
    if (el.dataset.rsvp) {
      const [id, a] = el.dataset.rsvp.split(':')
      for (const k of ['Yes', 'No', 'Maybe']) delete st.effects['rsvp:' + id + ':' + k]
      st.effects['rsvp:' + id + ':' + a] = true
      el.parentElement.querySelectorAll('[data-rsvp]').forEach((b) => b.setAttribute('aria-pressed', String(b === el)))
      $('[data-rsvp-note="' + id + '"]').textContent = { Yes: 'You are going.', No: 'You declined this event.', Maybe: 'You might go.' }[a]
      return
    }
  })
})()`

function done(t, state) {
  if (t.type === 'any') return t.of.some((test) => flowStepDone({ test }, state))
  return false
}

export const calendarFlow = { spec: calendarSpec, render: renderCalendar, css, runtime, done }
