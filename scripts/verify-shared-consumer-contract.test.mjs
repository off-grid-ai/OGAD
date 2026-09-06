import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { isolatedConsumer, assertPassed, writeJson } from './lib/shared-consumer-fixture.mjs'

test('real ordered artifacts certify required Desktop contracts without claiming its local Clipboard', (t) => {
  const fixture = isolatedConsumer(t)
  assertPassed(fixture.build())
  assertPassed(fixture.verify())
  const proof = join(fixture.shared, 'packages/application/dist/.workspace-build-provenance.json')
  const originalProof = readFileSync(proof)
  execFileSync(process.execPath, [
    join(fixture.shared, 'scripts/build-workspaces.mjs'),
    '--print-order'
  ])
  assert.deepEqual(readFileSync(proof), originalProof)

  const binding = join(fixture.desktop, 'node_modules/@offgrid/models')
  const wrong = join(fixture.desktop, 'packages/models')
  cpSync(join(fixture.shared, 'packages/models'), wrong, { recursive: true })
  rmSync(binding)
  symlinkSync(wrong, binding)
  const wrongBinding = fixture.verify()
  assert.equal(wrongBinding.status, 1)
  assert.match(
    wrongBinding.stderr,
    /@offgrid\/models resolves outside the verified shared workspace/
  )
  rmSync(binding)
  symlinkSync(join(fixture.shared, 'packages/models'), binding)
  assertPassed(fixture.verify())

  const source = join(fixture.shared, 'packages/models/payload/index.mjs')
  const oldBytes = readFileSync(source)
  const times = statSync(source)
  writeFileSync(source, Buffer.concat([oldBytes, Buffer.from('\n// changed input\n')]))
  utimesSync(source, times.atime, times.mtime)
  const staleSource = fixture.verify()
  assert.equal(staleSource.status, 1)
  assert.match(staleSource.stderr, /Shared build inputs changed/)
  writeFileSync(source, oldBytes)
  utimesSync(source, times.atime, times.mtime)
  assertPassed(fixture.verify())

  const output = join(fixture.shared, 'packages/models/dist/index.mjs')
  const builtBytes = readFileSync(output)
  writeFileSync(output, Buffer.concat([builtBytes, Buffer.from('\n// stale output\n')]))
  const staleOutput = fixture.verify()
  assert.equal(staleOutput.status, 1)
  assert.match(staleOutput.stderr, /built artifact content does not match provenance/)
  writeFileSync(output, builtBytes)

  rmSync(proof)
  const absent = fixture.verify()
  assert.equal(absent.status, 1)
  assert.match(absent.stderr, /ENOENT/)
  writeJson(proof, { version: -1 })
  const malformed = fixture.verify()
  assert.equal(malformed.status, 1)
  assert.match(malformed.stderr, /invalid or unsupported/)

  writeFileSync(proof, originalProof)
  writeFileSync(join(fixture.shared, 'scripts/package-fixture.mjs'), 'process.exit(1)\n')
  const interrupted = fixture.build()
  assert.equal(interrupted.status, 1)
  assert.throws(() => readFileSync(proof), { code: 'ENOENT' })
})
