// Booking flow (OpenTable / salon / yoga studio): date picker, party size or service, time slots
// (some full), a details form, and a confirm step that needs the user (takeover). A goal that
// accepts only a full slot ends in fail.

import { esc, cookieSteps, MONTHS } from './flows.mjs'
import { FIRST_NAMES, LAST_NAMES } from './vocab-pools.mjs'

const VENUES = {
  restaurant: { names: ['Spice Route', 'The Bombay Canteen', 'Olive Bar', 'Toit', 'Masala Library', 'Cafe Mondegar', 'Sana-di-ge'], what: 'a table', heading: 'Reserve a table' },
  salon: { names: ['Looks Salon', 'Bodycraft', 'Enrich', 'Toni & Guy', 'Juice Salon'], what: 'an appointment', heading: 'Book an appointment' },
  yoga: { names: ['Iyengar Yogashraya', 'Cult Yoga', 'Sarva Studio', 'The Yoga House', 'Mysore Ashtanga'], what: 'a class', heading: 'Book a class' }
}
const SLOTS = {
  restaurant: ['6:00 PM', '6:30 PM', '7:00 PM', '7:30 PM', '8:00 PM', '8:30 PM', '9:00 PM', '9:30 PM', '10:00 PM'],
  salon: ['10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM', '6:00 PM'],
  yoga: ['6:00 AM', '7:00 AM', '8:00 AM', '9:30 AM', '5:30 PM', '6:30 PM', '7:30 PM']
}
const people = (n) => `${n} ${n === 1 ? 'person' : 'people'}`

function bookingSpec(rng, base, id) {
  const kind = rng.pick(['restaurant', 'restaurant', 'salon', 'yoga'])
  const v = VENUES[kind]
  const venue = rng.pick(v.names)
  const selects = kind === 'restaurant'
    ? [{ id: id('bs'), label: 'Party size', options: Array.from({ length: 8 }, (_, i) => people(i + 1)) }]
    : kind === 'salon'
      ? [{ id: id('bs'), label: 'Service', options: ['Haircut', 'Hair colour', 'Beard trim', 'Manicure', 'Pedicure', 'Head massage'] }, { id: id('bs'), label: 'Stylist', options: ['Any stylist', ...rng.sample(FIRST_NAMES, 3)] }]
      : [{ id: id('bs'), label: 'Class', options: ['Hatha', 'Vinyasa', 'Yin', 'Power yoga', 'Prenatal'] }, { id: id('bs'), label: 'Spots', options: ['1 spot', '2 spots', '3 spots'] }]
  const slots = SLOTS[kind].map((time) => ({ id: id('sl'), time, full: rng.chance(0.3) }))
  if (slots.every((s) => s.full)) slots[slots.length - 1].full = false
  const fields = [{ id: id('bf'), label: 'Full name' }, { id: id('bf'), label: 'Phone' }, { id: id('bf'), label: 'Email' }]
  const spec = {
    ...base, start: 'home', path: rng.pick(['/', '/book', `/r/${venue.toLowerCase().replace(/[^a-z]+/g, '-')}`]), heading: venue, venue, kind, venueHeading: v.heading,
    rating: (rng.int(38, 49) / 10).toFixed(1), area: rng.pick(['Koregaon Park', 'Bandra West', 'Indiranagar', 'Hauz Khas', 'Baner', 'Colaba']),
    dateBtnId: id('dt'), monthNextId: id('mn'), dayIds: Object.fromEntries([9, 10].map((m) => [m, Array.from({ length: 31 }, (_, i) => id(`d${m}_${i + 1}_`))])),
    selects, slots, fields, availId: id('av'), confirmId: id('cf'), backId: id('bk'), notesId: id('bn')
  }
  const month = rng.chance(0.4) ? 10 : 9
  const day = month === 9 ? rng.int(17, 31) : rng.int(1, 28)
  const dateLabel = `${day} ${MONTHS[month]} 2026`
  const choices = selects.map((s) => ({ ...s, value: rng.pick(s.options.slice(kind === 'restaurant' ? 1 : 0, kind === 'restaurant' ? 6 : undefined)) }))
  const first = rng.pick(FIRST_NAMES); const last = rng.pick(LAST_NAMES)
  const details = [`${first} ${last}`, `9${rng.int(100000000, 999999999)}`, `${first.toLowerCase()}.${last.toLowerCase()}@example.com`]

  const full = slots.filter((s) => s.full)
  const mode = full.length && rng.chance(0.3) ? 'full' : rng.chance(0.25) ? 'earliest' : 'time'
  let slot
  let after = null
  if (mode === 'full') slot = rng.pick(full)
  else if (mode === 'earliest') {
    const i = rng.int(0, slots.length - 1)
    after = slots[i]
    slot = slots.slice(i).find((s) => !s.full)
    if (!slot) return bookingSpec(rng, base, id)
  } else slot = rng.pick(slots.filter((s) => !s.full))

  const steps = [
    ...cookieSteps(spec),
    { title: `Pick ${dateLabel}`, check: `text "Date: ${dateLabel}"`, test: { type: 'picked', key: spec.dateBtnId, value: dateLabel }, view: 'home', action: { kind: 'date', id: spec.dateBtnId, month, day } },
    ...choices.map((c) => ({ title: `Set ${c.label} to ${c.value}`, check: `combobox "${c.label}" = ${c.value}`, test: { type: 'value', id: c.id, value: c.value }, view: 'home', action: { kind: 'select', id: c.id, value: c.value } })),
    { title: 'Click Check availability', check: `heading "Available times on ${dateLabel}"`, test: { type: 'view', view: 'slots' }, view: 'home', action: { kind: 'click', id: spec.availId } },
    { title: mode === 'earliest' ? `Choose the first free slot from ${after.time}` : `Choose the ${slot.time} slot`, check: 'heading "Your details"', test: { type: 'picked', key: 'slot', value: slot.time }, view: 'slots', action: { kind: 'click', id: slot.id } },
    ...fields.map((f, i) => ({ title: `Set ${f.label} to ${details[i]}`, check: `textbox "${f.label}" = ${details[i]}`, test: { type: 'value', id: f.id, value: details[i] }, view: 'details', action: { kind: 'type', id: f.id, value: details[i] } })),
    { title: 'Click Confirm booking', check: 'heading "Confirm your booking"', test: { type: 'gate', gate: 'book' }, view: 'details', action: { kind: 'click', id: spec.confirmId } }
  ]
  const what = kind === 'restaurant' ? `a table for ${choices[0].value.replace(/ (people|person)$/, '')}` : kind === 'salon' ? `a ${choices[0].value.toLowerCase()} with ${choices[1].value === 'Any stylist' ? 'any stylist' : choices[1].value}` : `${choices[1].value} in the ${choices[0].value} class`
  const who = `Name ${details[0]}, phone ${details[1]}, email ${details[2]}.`
  const when = `${day} ${MONTHS[month]}`
  let goal
  if (mode === 'full') goal = rng.pick([`Book ${what} at ${venue} on ${when} at ${slot.time}. Only ${slot.time} works for me. ${who}`, `At ${venue}, reserve ${what} on ${when}, ${slot.time} sharp, no other time. ${who}`])
  else if (mode === 'earliest') goal = `Book ${what} at ${venue} on ${when}, the earliest free slot from ${after.time}. ${who}`
  else goal = rng.pick([`Book ${what} at ${venue} on ${when} at ${slot.time}. ${who}`, `Reserve ${what} at ${venue} for ${when}, ${slot.time}. ${who}`])
  const task = { family: 'booking', goal, steps, answer: `Booked ${venue} on ${dateLabel} at ${slot.time}`, done: { type: 'gatePassed', gate: 'book' } }
  if (mode === 'full') Object.assign(task, { failWhen: { type: 'view', view: 'slots' }, failReason: `${slot.time} is full on ${dateLabel}`, answer: null })
  return { spec, task }
}

function renderBooking(spec) {
  const days = (m) => `<div class="cal" data-month="${m}" ${m === 9 ? '' : 'hidden'}><strong style="grid-column:span 7">${MONTHS[m]} 2026</strong>${spec.dayIds[m].slice(0, m === 9 ? 31 : 30).map((d, i) => `<button class="ghost" data-gen-id="${d}" data-day="${i + 1} ${MONTHS[m]} 2026" aria-label="${i + 1} ${MONTHS[m]}">${i + 1}</button>`).join('')}</div>`
  const select = (s) => `<label>${esc(s.label)} <select data-gen-id="${s.id}" aria-label="${esc(s.label)}"><option>Select</option>${s.options.map((o) => `<option>${esc(o)}</option>`).join('')}</select></label>`
  const slot = (s) => s.full
    ? `<button class="ghost slot" disabled aria-label="${s.time}, full">${s.time}<br><small>Full</small></button>`
    : `<button class="ghost slot" data-gen-id="${s.id}" data-pick-key="slot" data-pick-value="${s.time}" data-slot-go aria-pressed="false">${s.time}</button>`
  return {
    views: `<section data-view="home"><h1>${esc(spec.venue)}</h1><p>${spec.rating} ★ · ${esc(spec.area)} · ${spec.kind === 'restaurant' ? 'North Indian, Coastal' : spec.kind === 'salon' ? 'Unisex salon' : 'Yoga studio'}</p>
      <div class="widget"><h2>${esc(spec.venueHeading)}</h2>
      <div><button class="ghost" data-gen-id="${spec.dateBtnId}" data-dp>Choose a date</button><div data-dp-panel hidden>${days(9)}${days(10)}<button class="ghost" data-gen-id="${spec.monthNextId}" data-dp-next aria-label="Next month">Next month ›</button></div></div>
      ${spec.selects.map(select).join(' ')}
      <p><button data-gen-id="${spec.availId}" data-avail>Check availability</button></p></div>
      <h2>About</h2><p>Open daily. Free cancellation up to 2 hours before.</p></section>
    <section data-view="slots" hidden><h1 id="slots-title">Available times</h1><div class="slots">${spec.slots.map(slot).join('')}</div></section>
    <section data-view="details" hidden><h1>Your details</h1><p id="summary"></p>
      ${spec.fields.map((f) => `<label>${f.label} <input data-gen-id="${f.id}" aria-label="${f.label}" autocomplete="off"></label><br>`).join('')}
      <label>Special requests <textarea data-gen-id="${spec.notesId}" aria-label="Special requests"></textarea></label><br>
      <button data-gen-id="${spec.confirmId}" data-confirm-book>Confirm booking</button></section>
    <section data-view="gate-book" hidden><h1>Confirm your booking</h1><p>Enter the one-time code we sent to your phone, or pay the deposit, to hold this booking.</p><label>One-time code <input autocomplete="one-time-code"></label></section>`
  }
}

const css = `
  .widget{border:1px solid #ddd;padding:12px;max-width:640px;display:flex;flex-direction:column;gap:10px}
  .slots{display:flex;flex-wrap:wrap;gap:8px} .slot{min-width:92px} .slot[disabled]{opacity:.45;cursor:not-allowed}`

const runtime = String.raw`
;(() => {
  const { st, show, status, $ } = window.__ogx
  const spec = window.__SPEC
  const field = (gid) => $('[data-gen-id="' + gid + '"]')
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button,a'); if (!el) return
    if (el.dataset.day) { $('[data-dp]').textContent = 'Date: ' + el.dataset.day; return }
    if (el.dataset.avail !== undefined) {
      const date = st.picked[spec.dateBtnId]
      const missing = spec.selects.find((s) => field(s.id).value === 'Select')
      if (!date) { status('Choose a date first.'); return }
      if (missing) { status('Choose ' + missing.label.toLowerCase() + ' first.'); return }
      $('#slots-title').textContent = 'Available times on ' + date
      show('slots'); return
    }
    if (el.dataset.slotGo !== undefined) {
      $('#summary').textContent = spec.venue + ' · ' + st.picked[spec.dateBtnId] + ' · ' + el.dataset.pickValue + ' · ' + spec.selects.map((s) => field(s.id).value).join(' · ')
      show('details'); return
    }
    if (el.dataset.confirmBook !== undefined) {
      const empty = spec.fields.find((f) => !field(f.id).value.trim())
      if (empty) { status('Fill in ' + empty.label + '.'); return }
      st.gate = 'book'; show('gate-book'); return
    }
  })
  window.__ogxResolve = (g) => {
    if (g === 'book') { st.effects.booked = true; status('Booking confirmed.'); return 'confirmed the booking' }
    return 'done'
  }
})()`

export const bookingFlow = { spec: bookingSpec, render: renderBooking, css, runtime, gates: { book: 'confirm the booking' } }
