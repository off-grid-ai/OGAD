import console from 'node:console'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'

const RATCHET_RULES = new Set([
  'max-lines',
  'max-lines-per-function',
  'complexity',
  'max-params',
  '@typescript-eslint/no-explicit-any',
  '@typescript-eslint/no-shadow',
  'curly',
  'eqeqeq',
  'no-console',
  'no-else-return',
  'no-empty',
  'prefer-template'
])

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = path.join(root, '.eslint-structural-baseline.json')
const baseline = JSON.parse(await readFile(baselinePath, 'utf8'))
const eslint = new ESLint({ cwd: root, cache: false })
const results = await eslint.lintFiles(['src', 'pro'])
const formatter = await eslint.loadFormatter('stylish')
const formatted = await formatter.format(results)

if (formatted) process.stdout.write(formatted)

const currentViolations = new Set()
const ratchetFailures = []
const improvedEntries = []

const isTestPath = (filePath) =>
  /(^|\/)(__tests__|tests?)(\/|\.)/.test(filePath) ||
  /\.(test|spec|dbtest)\.[cm]?[jt]sx?$/.test(filePath)

const violationValue = (message) => {
  const match = message.message.match(/(?:complexity of |lines \(|parameters \()(\d+)/)
  return match ? Number(match[1]) : 1
}

const violationsByRule = (messages) => {
  const values = {}
  for (const message of messages) {
    const rule = message.ruleId
    if (!rule) continue
    ;(values[rule] ??= []).push(violationValue(message))
  }
  for (const rule of Object.keys(values)) values[rule].sort((a, b) => b - a)
  return values
}

for (const result of results) {
  const relativePath = path.relative(root, result.filePath).split(path.sep).join('/')
  // Test code is still linted above and every ERROR still fails below. Its structural warnings do
  // not belong in the production debt baseline: old test shape must not make a new production file
  // look clean, and an out-of-scope test cannot make the production gate impossible to satisfy.
  if (isTestPath(relativePath)) continue
  const ratchetedMessages = result.messages.filter(({ ruleId }) => RATCHET_RULES.has(ruleId))
  if (ratchetedMessages.length === 0) continue

  currentViolations.add(relativePath)
  const accepted = baseline.files[relativePath]
  const actual = violationsByRule(ratchetedMessages)
  if (!accepted) {
    ratchetFailures.push(`${relativePath} (new or unbaselined file)`)
    continue
  }
  for (const [rule, values] of Object.entries(actual)) {
    const limits = accepted[rule] ?? []
    if (
      values.length > limits.length ||
      values.some((value, index) => value > (limits[index] ?? 0))
    ) {
      ratchetFailures.push(`${relativePath} (${rule} increased)`)
    } else if (
      values.length < limits.length ||
      values.some((value, index) => value < limits[index])
    ) {
      improvedEntries.push(`${relativePath} (${rule} improved)`)
    }
  }
  for (const rule of Object.keys(accepted)) {
    if (!(rule in actual)) improvedEntries.push(`${relativePath} (${rule} repaired)`)
  }
}

const staleEntries = Object.keys(baseline.files).filter(
  (filePath) => !currentViolations.has(filePath)
)
const errorCount = results.reduce(
  (count, result) => count + result.messages.filter(({ severity }) => severity === 2).length,
  0
)

if (ratchetFailures.length > 0) {
  console.error('\nLint debt increased in:')
  for (const failure of ratchetFailures) console.error(`  - ${failure}`)
}

if (staleEntries.length > 0) {
  console.error('\nRemove repaired or deleted files from .eslint-structural-baseline.json:')
  for (const filePath of staleEntries) console.error(`  - ${filePath}`)
}

if (improvedEntries.length > 0) {
  console.error('\nLower the repaired limits in .eslint-structural-baseline.json:')
  for (const entry of improvedEntries) console.error(`  - ${entry}`)
}

if (
  ratchetFailures.length > 0 ||
  staleEntries.length > 0 ||
  improvedEntries.length > 0 ||
  errorCount > 0
) {
  process.exitCode = 1
}
