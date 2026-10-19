// Re-render the AX part of ms-swift rows with the current contract code (compaction and the
// focused cut), so rows captured with an older contract match what the harness sends now.
//   node rerender.mjs <file.jsonl> [...]   (rewrites each file in place)
// The goal comes from the GOAL line and the focus from the [>] plan line, as the harness does.

import { createReadStream, createWriteStream, renameSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { boundedSnapshot, checkLines } from '../contract.mjs'

const SHORTENED = '[Snapshot shortened.'

// Streamed line by line: a round's actor file can exceed Node's 512 MB string limit.
for (const file of process.argv.slice(2)) {
  let rows = 0, changed = 0
  const tmp = file + '.rerender.tmp'
  const out = createWriteStream(tmp)
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (!line) continue
    const row = JSON.parse(line)
    rows++
    const user = row.messages.find((m) => m.role === 'user')
    const at = user.content.indexOf('\nAX:\n')
    if (at >= 0) {
      const head = user.content.slice(0, at)
      const ax = user.content.slice(at + 5)
      if (!ax.startsWith(SHORTENED)) {
        const goal = (head.match(/^GOAL: (.*)$/m) ?? [])[1] ?? ''
        const focus = (head.match(/^\[>\] \d+ (.*?)(?: \| check:.*)?$/m) ?? [])[1] ?? ''
        const planLines = [...head.matchAll(/^\[[x> ]\] \d+ (.*?)(?: \| check: (.*))?$/gm)].map((m) => ({ title: m[1], check: m[2] ?? '' }))
        let newHead = head.replace(/\nCHECKS: [^\n]*/, '')
        if (planLines.some((p) => p.check) && /\nPAST:/.test(newHead)) newHead = newHead.replace('\nPAST:', `\nCHECKS: ${checkLines(planLines, ax)}\nPAST:`)
        const next = `${newHead}\nAX:\n${boundedSnapshot(ax, goal, focus)}`
        if (next !== user.content) { user.content = next; changed++ }
      }
    }
    if (!out.write(JSON.stringify(row) + '\n')) await new Promise((r) => out.once('drain', r))
  }
  await new Promise((r) => out.end(r))
  renameSync(tmp, file)
  console.log(JSON.stringify({ file, rows, changed }))
}
