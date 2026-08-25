#!/usr/bin/env node

// APP-250's OS boundary: a scripted actions helper. Records every command it
// receives and answers reminders.list with what actually landed, so the
// engine's read-back verification runs for real against this fake world -
// and the log proves create-then-list ordering.

import fs from 'node:fs'

const logFile = process.env.OFFGRID_APP250_HELPER_LOG
const raw = process.argv[2] ?? '{}'
const cmd = JSON.parse(raw)

const record = (entry) => {
  if (logFile) {
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
  }
}

const reply = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  process.exit(0)
}

record({ command: cmd.command, args: cmd.args ?? {} })

if (cmd.command === 'reminders.create') {
  reply({ ok: true, result: { id: `e2e-${Date.now()}` } })
}
if (cmd.command === 'reminders.list') {
  const lines = logFile && fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : []
  const reminders = lines
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.command === 'reminders.create')
    .map((entry) => ({ id: 'e2e', title: String(entry.args.title ?? '') }))
  reply({ ok: true, result: { reminders } })
}
reply({ ok: true, result: {} })
