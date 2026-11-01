// The native actions helper is an executable (the Swift helper on macOS). This stand-in keeps
// reminders in a JSON file beside it: create returns an id, list reads them back, delete removes
// by that id (the undo path). It is installed where a development build looks first,
// <cwd>/scripts/actions-helper, so a test that uses it runs from its temp profile and the real
// helper, which would touch this Mac's Reminders, is never found.
import fs from 'node:fs'
import path from 'node:path'

const HELPER = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const store = path.join(__dirname, 'reminders.json')
const state = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : { created: 0, landed: [] }
const cmd = JSON.parse(process.argv[2])
const reply = (body) => {
  fs.writeFileSync(store, JSON.stringify(state))
  process.stdout.write(JSON.stringify(body) + '\\n')
}
if (cmd.command === 'reminders.create') {
  const item = { id: 'rt' + ++state.created, title: String(cmd.args.title) }
  state.landed.push(item)
  reply({ ok: true, result: { id: item.id } })
} else if (cmd.command === 'reminders.list') {
  reply({ ok: true, result: { reminders: state.landed.map(({ title }) => ({ title })) } })
} else if (cmd.command === 'reminders.delete') {
  const index = state.landed.findIndex((item) => item.id === cmd.args.id)
  if (index === -1) reply({ ok: false, error: 'no reminder with id ' + cmd.args.id })
  else {
    state.landed.splice(index, 1)
    reply({ ok: true, result: { deleted: cmd.args.id } })
  }
} else reply({ ok: false, error: 'unhandled ' + cmd.command })
`

export interface FakeActionsHelper {
  /** The reminders the helper holds now. */
  landed(): Array<{ id: string; title: string }>
  /** Run the test from `root` so the app finds this helper first; returns the restore. */
  useFrom(): () => void
}

export function installFakeActionsHelper(root: string): FakeActionsHelper {
  const dir = path.join(root, 'scripts', 'actions-helper')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'actions-helper'), HELPER, { mode: 0o755 })
  const store = path.join(dir, 'reminders.json')
  return {
    landed: () => (fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')).landed : []),
    useFrom: () => {
      const previous = process.cwd()
      process.chdir(root)
      return () => process.chdir(previous)
    }
  }
}
