import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { startDevSupervisor } from './dev.mjs'
import { isolatedConsumer, assertPassed } from './lib/shared-consumer-fixture.mjs'

async function waitFor(predicate, message) {
  const deadline = Date.now() + 60000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test(
  'development supervisor serializes edits, blocks failed builds, recovers, and stops its child',
  { timeout: 120000 },
  async (t) => {
    let supervisor
    const fixture = isolatedConsumer({
      after: (cleanup) =>
        t.after(async () => {
          await supervisor?.stop()
          cleanup()
        })
    })
    const trace = join(fixture.desktop, 'child-events.jsonl')
    writeFileSync(trace, '')
    // Native staging and Electron are external child-process boundaries. The build, proof and
    // consumer verifier above remain their real production owners over isolated copied artifacts.
    writeFileSync(join(fixture.desktop, 'scripts/stage-native.mjs'), '')
    // Replace the fixture symlink itself before writing a child fixture. Never follow it into the
    // real dependency checkout.
    rmSync(join(fixture.desktop, 'node_modules/electron-vite'), { force: true })
    rmSync(join(fixture.desktop, 'node_modules/.cache'), { force: true })
    const vite = join(fixture.desktop, 'node_modules/electron-vite/bin')
    mkdirSync(vite, { recursive: true })
    writeFileSync(
      join(vite, 'electron-vite.js'),
      `const fs = require('node:fs');
const trace = ${JSON.stringify(trace)};
fs.appendFileSync(trace, JSON.stringify({type:'start',pid:process.pid})+'\\n');
process.on('SIGTERM',()=>{fs.appendFileSync(trace,JSON.stringify({type:'stop',pid:process.pid})+'\\n');process.exit(0)});
setInterval(()=>{},1000);
`
    )
    const events = () =>
      readFileSync(trace, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    const starts = () => events().filter((event) => event.type === 'start').length
    assertPassed(fixture.build())
    const proofPath = join(
      fixture.shared,
      'packages/application/dist/.workspace-build-provenance.json'
    )
    const proofTime = statSync(proofPath).mtimeMs
    const options = {
      desktopRoot: fixture.desktop,
      sharedRoot: fixture.shared,
      pollMs: 30,
      debounceMs: 60
    }
    supervisor = await startDevSupervisor(options)
    await waitFor(() => starts() === 1, 'initial verified child must start')
    assert.equal(statSync(proofPath).mtimeMs, proofTime, 'valid proof starts without rebuilding')
    assert.throws(() => startDevSupervisor(options), /Another development supervisor/)
    assertPassed(fixture.verify())

    const input = join(fixture.shared, 'packages/models/payload/watched-change.txt')
    writeFileSync(input, 'first edit')
    writeFileSync(input, 'coalesced edit')
    await waitFor(() => starts() === 2, 'coalesced edits must produce one replacement child')
    assert.deepEqual(
      events().map((event) => event.type),
      ['start', 'stop', 'start']
    )
    assertPassed(fixture.verify())

    const packageCommand = join(fixture.shared, 'scripts/package-fixture.mjs')
    const originalCommand = readFileSync(packageCommand)
    const building = join(fixture.desktop, 'build-entered')
    const release = join(fixture.desktop, 'release-build')
    writeFileSync(
      packageCommand,
      `import {existsSync,writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(building)},'building');
while(!existsSync(${JSON.stringify(release)})) await new Promise(r=>setTimeout(r,20));
${originalCommand.toString()}`
    )
    await waitFor(() => {
      try {
        return readFileSync(building, 'utf8') === 'building'
      } catch {
        return false
      }
    }, 'build must enter its boundary')
    writeFileSync(input, 'edit during an active build')
    writeFileSync(release, 'continue')
    await waitFor(() => starts() === 3, 'edit during build must retry with the new baseline')
    assertPassed(fixture.verify())
    const failed = join(fixture.desktop, 'build-failed')
    writeFileSync(
      packageCommand,
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(failed)},'failed');process.exit(1);`
    )
    await waitFor(() => {
      try {
        return readFileSync(failed, 'utf8') === 'failed'
      } catch {
        return false
      }
    }, 'failed build must be observed')
    assert.equal(starts(), 3, 'failed build must not launch a replacement')
    assert.notEqual(fixture.verify().status, 0)
    writeFileSync(packageCommand, originalCommand)
    await waitFor(() => starts() === 4, 'a later edit must recover after failure')
    assertPassed(fixture.verify())
    await supervisor.stop()
    assert.deepEqual(
      events().map((event) => event.type),
      ['start', 'stop', 'start', 'stop', 'start', 'stop', 'start', 'stop']
    )
    for (const event of events().filter((event) => event.type === 'start')) {
      assert.throws(() => process.kill(event.pid, 0), { code: 'ESRCH' })
    }
  }
)

test(
  'signals during a Shared build stop descendants and release the supervisor lock',
  { timeout: 60000 },
  async (t) => {
    const children = []
    const fixture = isolatedConsumer({
      after: (cleanup) =>
        t.after(async () => {
          for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
            await waitFor(
              () => child.exitCode !== null || child.signalCode !== null,
              'supervisor cleanup must finish'
            )
          }
          cleanup()
        })
    })
    cpSync(
      fileURLToPath(new URL('./dev.mjs', import.meta.url)),
      join(fixture.desktop, 'scripts/dev.mjs')
    )
    const entryAlias = join(fixture.desktop, 'scripts/dev-entry.mjs')
    symlinkSync(join(fixture.desktop, 'scripts/dev.mjs'), entryAlias)
    rmSync(join(fixture.desktop, 'node_modules/.cache'), { force: true })
    const entered = join(fixture.desktop, 'blocked-build.json')
    const lock = join(fixture.desktop, 'node_modules/.cache/offgrid-dev-supervisor.lock')
    // The real ordered builder reaches a package command with a real descendant. Both ignore TERM
    // so shutdown must also exercise the supervisor's bounded process-group escalation.
    writeFileSync(
      join(fixture.shared, 'scripts/package-fixture.mjs'),
      `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"], {stdio:['ignore','ignore','ignore','ipc']});
child.once('message', () => writeFileSync(${JSON.stringify(entered)}, JSON.stringify([process.pid, child.pid])));
setInterval(()=>{},1000);
`
    )
    for (const signal of ['SIGTERM', 'SIGINT']) {
      rmSync(entered, { force: true })
      const child = spawn(process.execPath, [entryAlias], {
        cwd: fixture.desktop,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      children.push(child)
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += chunk
      })
      child.stderr.on('data', (chunk) => {
        output += chunk
      })
      await waitFor(() => {
        assert.equal(child.exitCode, null, output)
        assert.equal(child.signalCode, null, output)
        return existsSync(entered)
      }, `supervisor must reach build before ${signal}`)
      assert.equal(readFileSync(lock, 'utf8'), String(child.pid))
      const buildPids = JSON.parse(readFileSync(entered, 'utf8'))
      assert.equal(buildPids.length, 2)
      child.kill(signal)
      await waitFor(
        () => child.exitCode !== null || child.signalCode !== null,
        `supervisor must finish ${signal}`
      )
      assert.equal(child.exitCode, 0, output)
      assert.equal(existsSync(lock), false, 'shutdown must release its exclusive lock')
      for (const pid of buildPids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
      assert.equal(
        existsSync(
          join(fixture.shared, 'packages/application/dist/.workspace-build-provenance.json')
        ),
        false,
        'interrupted build must not certify output'
      )
    }
  }
)
