import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { ESLint } from 'eslint'

const rules = new Set([
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

const violationValue = (message) => {
  const match = message.message.match(/(?:complexity of |lines \(|parameters \()(\d+)/)
  return match ? Number(match[1]) : 1
}

const isTestPath = (filePath) =>
  /(^|\/)(__tests__|tests?)(\/|\.)/.test(filePath) ||
  /\.(test|spec|dbtest)\.[cm]?[jt]sx?$/.test(filePath)

const eslint = new ESLint({ cwd: process.cwd(), cache: false })
const results = await eslint.lintFiles(['src', 'pro'])
const files = {}
for (const result of results) {
  const relativePath = path.relative(process.cwd(), result.filePath).split(path.sep).join('/')
  // The production ratchet must never inherit structural debt from tests. Tests are still linted,
  // and every lint error still fails the normal ESLint command; only their legacy structural
  // warnings are outside this production baseline.
  if (isTestPath(relativePath)) continue
  const accepted = {}
  for (const message of result.messages) {
    if (!rules.has(message.ruleId)) continue
    ;(accepted[message.ruleId] ??= []).push(violationValue(message))
  }
  if (Object.keys(accepted).length === 0) continue
  for (const values of Object.values(accepted)) values.sort((a, b) => b - a)
  files[relativePath] = accepted
}

await writeFile(
  path.join(process.cwd(), '.eslint-structural-baseline.json'),
  `${JSON.stringify({ version: 1, files }, null, 2)}\n`
)
