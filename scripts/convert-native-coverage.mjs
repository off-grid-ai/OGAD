// Use the same AST-aware converter as Vitest. The older c8 converter omits
// unnamed callbacks, which are part of the recording and shortcut contracts.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeProcessCovs } from '@bcoe/v8-coverage'
import convert from 'ast-v8-to-istanbul'
import { parseAstAsync } from 'vitest/node'
import libCoverage from 'istanbul-lib-coverage'

const [rawDirectory, reportDirectory] = process.argv.slice(2)
const snapshots = []
for (const file of await fs.readdir(rawDirectory)) {
  if (/^coverage-.*\.json$/.test(file))
    snapshots.push(JSON.parse(await fs.readFile(path.join(rawDirectory, file), 'utf8')))
}
const report = libCoverage.createCoverageMap({})
for (const script of mergeProcessCovs(snapshots).result) {
  if (!script.url.startsWith('file:')) continue
  const file = fileURLToPath(script.url)
  const normalized = file.replaceAll('\\', '/')
  if (!normalized.includes('/compiled/pro/') && !normalized.includes('/compiled/src/')) continue
  const code = await fs.readFile(file, 'utf8')
  const encoded = code.match(/sourceMappingURL=data:application\/json;base64,([^\s]+)/)?.[1]
  if (!encoded) continue
  const sourceMap = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  if (sourceMap.sources.some((source) => source.includes('__tests__'))) continue
  const exportAssignment = code.indexOf('module.exports = __toCommonJS(')
  const generatedEnd = exportAssignment < 0 ? 0 : code.indexOf(';', exportAssignment) + 1
  report.merge(
    await convert({
      code,
      ast: await parseAstAsync(code),
      sourceMap,
      coverage: script,
      wrapperLength: 0,
      // esbuild's CommonJS export getters have no source functions. Match
      // Vitest's exclusion of generated export plumbing before source mapping.
      ignoreNode: (node) => (node.start < generatedEnd ? 'ignore-this-and-nested-nodes' : undefined)
    })
  )
}
if (!report.files().length) throw new Error('No native product source coverage was collected')
await fs.mkdir(reportDirectory, { recursive: true })
await fs.writeFile(
  path.join(reportDirectory, 'coverage-final.json'),
  JSON.stringify(report.toJSON())
)
console.log(`Converted native coverage for ${report.files().length} product source files`)
