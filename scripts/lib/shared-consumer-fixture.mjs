import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const desktopRoot = fileURLToPath(new URL('../..', import.meta.url))
const root = join(desktopRoot, '../shared')

export function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value))
}

/** Run real CLI owners over real compiled Off Grid modules. The only substituted boundary is
 * the package build command: package existing modules into an isolated output, not a compiler run.
 * Nothing writes to the repository's normal sources, dependency tree or dist. */
export function isolatedConsumer(t) {
  const temporary = mkdtempSync(join(tmpdir(), 'offgrid-proof-test-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const shared = join(temporary, 'shared')
  const desktop = join(temporary, 'desktop')
  for (const directory of [shared, desktop])
    mkdirSync(join(directory, 'scripts'), { recursive: true })
  for (const script of ['build-workspaces.mjs', 'workspace-build-provenance.mjs']) {
    cpSync(join(root, 'scripts', script), join(shared, 'scripts', script))
  }
  cpSync(
    join(desktopRoot, 'scripts/verify-shared-consumer-contract.mjs'),
    join(desktop, 'scripts/verify-shared-consumer-contract.mjs')
  )
  writeJson(join(shared, 'package.json'), {
    name: 'proof-fixture',
    private: true,
    workspaces: ['packages/*']
  })
  cpSync(join(desktopRoot, 'package.json'), join(desktop, 'package.json'))
  writeFileSync(
    join(shared, 'scripts/package-fixture.mjs'),
    `import { cpSync, rmSync } from 'node:fs';
rmSync('dist', {recursive:true,force:true}); cpSync('payload', 'dist', {recursive:true});
`
  )
  const packages = readdirSync(join(root, 'packages'), { withFileTypes: true }).filter((entry) =>
    entry.isDirectory()
  )
  for (const entry of packages) {
    const original = join(root, 'packages', entry.name)
    const target = join(shared, 'packages', entry.name)
    mkdirSync(target, { recursive: true })
    const manifest = JSON.parse(readFileSync(join(original, 'package.json'), 'utf8'))
    manifest.scripts = { build: 'node ../../scripts/package-fixture.mjs' }
    writeJson(join(target, 'package.json'), manifest)
    cpSync(join(original, 'dist'), join(target, 'payload'), {
      recursive: true,
      filter: (file) => !file.includes('.workspace-build-provenance.json')
    })
  }
  for (const directory of [shared, desktop]) {
    const modules = join(directory, 'node_modules')
    mkdirSync(join(modules, '@offgrid'), { recursive: true })
    for (const external of readdirSync(join(root, 'node_modules'))) {
      if (external !== '@offgrid')
        symlinkSync(join(root, 'node_modules', external), join(modules, external))
    }
    for (const entry of packages)
      symlinkSync(join(shared, 'packages', entry.name), join(modules, '@offgrid', entry.name))
  }
  // This is a real package with the same name but intentionally outside Shared's contract.
  const clipboard = join(desktop, 'packages/clipboard')
  mkdirSync(clipboard, { recursive: true })
  cpSync(join(shared, 'packages/clipboard/package.json'), join(clipboard, 'package.json'))
  cpSync(join(shared, 'packages/clipboard/payload'), join(clipboard, 'dist'), { recursive: true })
  const clipboardLink = join(desktop, 'node_modules/@offgrid/clipboard')
  rmSync(clipboardLink)
  symlinkSync(clipboard, clipboardLink)
  const run = (directory, script) =>
    spawnSync(process.execPath, [join(directory, 'scripts', script)], {
      cwd: directory,
      encoding: 'utf8'
    })
  const build = () => run(shared, 'build-workspaces.mjs')
  const verify = () => run(desktop, 'verify-shared-consumer-contract.mjs')
  return { shared, desktop, build, verify }
}

export function assertPassed(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout)
}
