// Preserve V8 counts while moving a source-mapped report between OS runners.
import fs from 'node:fs'
import path from 'node:path'

const [file, mode] = process.argv.slice(2)
if (!file || !['relative', 'absolute'].includes(mode))
  throw new Error('Expected report and relative/absolute mode')
const report = JSON.parse(fs.readFileSync(file, 'utf8'))
const normalized = {}
for (const [name, entry] of Object.entries(report)) {
  const relative =
    mode === 'relative' ? path.relative(process.cwd(), name).replaceAll('\\', '/') : name
  if (!relative.startsWith('pro/') || /__tests__|\.test\./.test(relative)) continue
  const key = mode === 'absolute' ? path.resolve(relative) : relative
  normalized[key] = { ...entry, path: key }
}
if (!Object.keys(normalized).length) throw new Error('Native source coverage is empty')
fs.writeFileSync(file, JSON.stringify(normalized))
