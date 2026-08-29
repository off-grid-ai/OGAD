#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const appArgument = process.argv[2]
const app = appArgument ? path.resolve(appArgument) : undefined
const timeoutMs = Number(process.env.OFFGRID_HELPER_PROBE_TIMEOUT_MS ?? 30_000)

if (!app || !fs.statSync(app, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('usage: node scripts/probe-packaged-helpers.mjs <path-to.app>')
  process.exit(2)
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error('OFFGRID_HELPER_PROBE_TIMEOUT_MS must be a positive number')
  process.exit(2)
}

const resources = path.join(app, 'Contents', 'Resources')
const probes = [
  {
    name: 'llama-server',
    relative: 'bin/llama/llama-server',
    args: ['--help'],
    // llama.cpp b9838+ dropped the "usage: llama-server [options]" banner; --help now leads
    // with "----- common params -----" and a flag list (e.g. the LLAMA_ARG_THREADS env note).
    // Match the current format and keep the legacy banner so an older engine still passes.
    output: /-+\s*common params|--help,\s*--usage|LLAMA_ARG_THREADS|usage:.*llama-server/is,
    libraryPath: true
  },
  {
    name: 'ffmpeg',
    relative: 'bin/ffmpeg',
    args: ['-version'],
    output: /^ffmpeg version\s+\S+/m
  },
  {
    name: 'Whisper',
    relative: 'bin/whisper/whisper-cli',
    args: ['--help'],
    output: /usage:.*whisper-cli[\s\S]*options:/i
  },
  {
    name: 'Computer Use capture',
    relative: 'bin/computer-use-capture',
    args: ['--help'],
    output: /usage: computer-use-capture/i
  },
  {
    name: 'image server',
    relative: 'bin/sd/sd-server',
    args: ['--help'],
    output: /stable-diffusion\.cpp[\s\S]*usage:.*sd-server/is,
    libraryPath: true
  },
  {
    name: 'image CLI',
    relative: 'bin/sd/sd-cli',
    args: ['--help'],
    output: /stable-diffusion\.cpp[\s\S]*usage:.*sd-cli/is,
    libraryPath: true
  }
]
const unsafeDependencyOutput = [
  {
    pattern: /Library not loaded:/i,
    reason: 'dependency loader error'
  },
  {
    pattern: /dyld(?:\[\d+\])?:.*(?:not found|no suitable image|image not found)/i,
    reason: 'dependency loader error'
  },
  {
    pattern: /loaded\s+\S*\s*backend\s+from\s+\/(?:opt\/homebrew|usr\/local)\//i,
    reason: 'loaded a build-host dependency'
  }
]

const failures = []
for (const probe of probes) {
  const executable = path.join(resources, probe.relative)
  let stat
  try {
    stat = fs.statSync(executable)
  } catch {
    failures.push(`${probe.name}: missing ${probe.relative}`)
    continue
  }
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    failures.push(`${probe.name}: ${probe.relative} is not an executable regular file`)
    continue
  }

  const binDir = path.dirname(executable)
  const env = { ...process.env }
  delete env.DYLD_LIBRARY_PATH
  delete env.DYLD_FALLBACK_LIBRARY_PATH
  if (probe.libraryPath) env.DYLD_LIBRARY_PATH = binDir

  const result = spawnSync(executable, probe.args, {
    cwd: binDir,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 10 * 1024 * 1024
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const output = `${stdout}\n${stderr}`.trim()

  const unsafe = unsafeDependencyOutput.find(({ pattern }) => pattern.test(output))
  if (unsafe) {
    failures.push(`${probe.name}: ${unsafe.reason}: ${output.slice(0, 500)}`)
    continue
  }
  if (result.error?.code === 'ETIMEDOUT') {
    failures.push(`${probe.name}: timed out after ${timeoutMs}ms`)
    continue
  }
  if (result.error) {
    failures.push(`${probe.name}: could not execute (${result.error.message})`)
    continue
  }
  if (result.status !== 0 || result.signal) {
    failures.push(
      `${probe.name}: exited status=${String(result.status)} signal=${String(result.signal)} output=${output.slice(0, 500)}`
    )
    continue
  }
  if (!probe.output.test(output)) {
    failures.push(`${probe.name}: produced no recognized real output: ${output.slice(0, 500)}`)
    continue
  }

  const firstOutputLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  console.log(`[helper-probe] ${probe.name}: ${firstOutputLine}`)
}

if (failures.length > 0) {
  console.error(`[helper-probe] ${failures.length} packaged helper probe(s) failed`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(`[helper-probe] ${probes.length} packaged helpers executed successfully`)
