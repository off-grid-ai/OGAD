// Compile modules separately so native V8 coverage retains function boundaries.
// Bundling many modules into one script can assign the bundle's startup count to
// uncalled source bodies after source-map conversion.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'

const output = path.resolve(process.argv[2])
const compiled = path.join(output, 'compiled')
const fixture = 'pro/main/__tests__/native-desktop.fixture.ts'
const sources = []
const pending = ['src', 'pro/main', 'pro/shared']
while (pending.length) {
  const directory = pending.pop()
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory() && entry.name !== '__tests__') pending.push(file)
    else if (entry.isFile() && /\.tsx?$/.test(file) && !/\.d\.ts$|\.test\./.test(file))
      sources.push(file)
  }
}
sources.push(fixture)
const aliases = [
  ['@offgrid/core/', 'src/'],
  ['@offgrid/pro/', 'pro/'],
  ['@renderer/', 'src/renderer/src/'],
  ['@/', 'src/renderer/src/']
]
for (const file of sources) {
  const target = path.join(compiled, file.replace(/\.tsx?$/, '.js'))
  let source = fs.readFileSync(file, 'utf8')
  source = source.replace(
    /(['"])(@offgrid\/core\/|@offgrid\/pro\/|@renderer\/|@\/)([^'"]+)\1/g,
    (_match, _quote, prefix, suffix) => {
      const directory = aliases.find(([name]) => name === prefix)[1]
      const original = path.join(directory, suffix)
      const emitted =
        fs.existsSync(original + '.ts') || fs.existsSync(original + '.tsx')
          ? path.join(compiled, original + '.js')
          : fs.existsSync(path.join(original, 'index.ts'))
            ? path.join(compiled, original, 'index.js')
            : path.join(compiled, original)
      let relative = path.relative(path.dirname(target), emitted).replaceAll('\\', '/')
      if (!relative.startsWith('.')) relative = './' + relative
      return JSON.stringify(relative)
    }
  )
  // Native dynamic imports use Node's ESM resolver, which requires extensions.
  source = source.replace(/import\((['"])(\.[^'"]+)\1\)/g, (match, _quote, specifier) => {
    const original = path.resolve(path.dirname(file), specifier)
    if (fs.existsSync(original + '.ts') || fs.existsSync(original + '.tsx'))
      return `import(${JSON.stringify(specifier + '.js')})`
    if (fs.existsSync(path.join(original, 'index.ts')))
      return `import(${JSON.stringify(specifier + '/index.js')})`
    return match
  })
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(target).href))
  source = source.replace(
    '../resources/linux-desktop/meeting-recorder.py?raw',
    '../resources/linux-desktop/meeting-recorder-source.js'
  )
  const result = transformSync(source, {
    sourcefile: path.resolve(file),
    loader: file.endsWith('.tsx') ? 'tsx' : 'ts',
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    jsx: 'automatic',
    sourcemap: 'external',
    sourcesContent: true
  })
  const map = JSON.parse(result.map)
  map.sources = [path.resolve(file)]
  map.sourceRoot = ''
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(
    target,
    result.code +
      '\n//# sourceMappingURL=data:application/json;base64,' +
      Buffer.from(JSON.stringify(map)).toString('base64')
  )
}
const recorder = path.join(compiled, 'pro/resources/linux-desktop/meeting-recorder-source.js')
fs.mkdirSync(path.dirname(recorder), { recursive: true })
fs.writeFileSync(
  recorder,
  'module.exports = {__esModule: true, default: ' +
    JSON.stringify(fs.readFileSync('pro/resources/linux-desktop/meeting-recorder.py', 'utf8')) +
    '};'
)
fs.writeFileSync(
  path.join(output, 'main.cjs'),
  'const {app}=require("electron"); app.setPath("userData", require("path").join(process.env.OFFGRID_NATIVE_PROFILE, "profile")); global.__OFFGRID_PRO__ = true; require("./compiled/pro/main/__tests__/native-desktop.fixture.js");'
)
