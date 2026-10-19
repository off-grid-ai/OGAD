import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Model names come from one place: describeModel / modelDisplayName in @offgrid/models, or a
// `name` / `modelName` field main already resolved with it. A screen that parses a model id or
// a file name on its own leaks raw ids sooner or later, so these per-screen helpers stay gone.

const ROOTS = ['src/renderer/src', 'pro/renderer', 'src/main', 'src/shared'].map((root) =>
  path.resolve(__dirname, '../../../../..', root)
)

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bresolveModelName\s*\(/, 'resolveModelName (use modelDisplayName)'],
  [/\bmodelNameForFile\s*\(/, 'modelNameForFile (use modelDisplayName)'],
  [/\.replace\(\/-Q\\d\.\*\$\/i/, 'a quant-stripping regex (use modelDisplayName)'],
  [/\$\{[^}]*\bname\} - \$\{[^}]*server[^}]*\.name\}/i, 'a "<model> - <server>" name'],
  [/\bid\.split\('\/'\)\.pop\(\)/, "a model id split on '/' (use modelDisplayName)"]
]

function sources(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory())
      return entry.name === 'node_modules' || entry.name === '__tests__' ? [] : sources(file)
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [file] : []
  })
}

describe('model display names have one owner', () => {
  it('no app code names a model with its own id parsing', () => {
    const files = ROOTS.flatMap(sources)
    expect(files.length).toBeGreaterThan(200)
    const offenders = files.flatMap((file) => {
      const text = fs.readFileSync(file, 'utf8')
      return FORBIDDEN.filter(([pattern]) => pattern.test(text)).map(
        ([, what]) => `${path.relative(process.cwd(), file)}: ${what}`
      )
    })
    expect(offenders).toEqual([])
  })
})
