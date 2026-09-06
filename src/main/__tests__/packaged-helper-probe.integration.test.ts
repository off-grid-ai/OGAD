import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const PROBE = path.join(REPO_ROOT, 'scripts', 'probe-packaged-helpers.mjs')
const CAN_COMPILE_NATIVE = process.platform === 'darwin' && fs.existsSync('/usr/bin/clang')
const HELPER_PATHS = [
  'bin/llama/llama-server',
  'bin/ffmpeg',
  'bin/whisper/whisper-cli',
  'bin/computer-use-capture',
  'bin/sd/sd-server',
  'bin/sd/sd-cli'
] as const

function compileProbeFixture(root: string): string {
  const executable = path.join(root, 'helper-fixture')
  const source = String.raw`
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
  const char *name = strrchr(argv[0], '/');
  name = name ? name + 1 : argv[0];
  const char *log = getenv("OFFGRID_HELPER_FIXTURE_LOG");
  if (log) {
    FILE *file = fopen(log, "a");
    if (file) { fprintf(file, "%s\n", name); fclose(file); }
  }
  const char *foreign = getenv("OFFGRID_HELPER_FIXTURE_FOREIGN");
  if (foreign && strcmp(foreign, name) == 0) {
    fprintf(stderr, "load_backend: loaded BLAS backend from /opt/homebrew/lib/libggml-blas.so\n");
  }
  const char *silent = getenv("OFFGRID_HELPER_FIXTURE_SILENT");
  if (silent && strcmp(silent, name) == 0) return 0;
  const char *failure = getenv("OFFGRID_HELPER_FIXTURE_FAIL");
  if (failure && strcmp(failure, name) == 0) return 70;
  const char *hang = getenv("OFFGRID_HELPER_FIXTURE_HANG");
  if (hang && strcmp(hang, name) == 0) while (1) {}
  if (strcmp(name, "llama-server") == 0) puts("----- common params -----\n-h, --help, --usage    print usage and exit\n-t, --threads N    number of CPU threads (env: LLAMA_ARG_THREADS)");
  else if (strcmp(name, "ffmpeg") == 0) puts("ffmpeg version 6.0-fixture");
  else if (strcmp(name, "whisper-cli") == 0) puts("usage: whisper-cli [options] file\noptions:");
  else if (strcmp(name, "computer-use-capture") == 0) puts("usage: computer-use-capture <output.png> <display-id> <excluded-window-id> <width> <height>");
  else if (strcmp(name, "sd-server") == 0) puts("stable-diffusion.cpp version fixture\nUsage: sd-server [options]");
  else if (strcmp(name, "sd-cli") == 0) puts("stable-diffusion.cpp version fixture\nUsage: sd-cli [options]");
  else return 64;
  return 0;
}
`
  const result = spawnSync('/usr/bin/clang', ['-x', 'c', '-', '-o', executable], {
    input: source,
    encoding: 'utf8'
  })
  if (result.status !== 0) throw new Error(result.stderr)
  return executable
}

function createApp(root: string): { app: string; log: string } {
  const app = path.join(root, 'Off Grid AI Desktop.app')
  const fixture = compileProbeFixture(root)
  for (const relative of HELPER_PATHS) {
    const target = path.join(app, 'Contents', 'Resources', relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(fixture, target)
    fs.chmodSync(target, 0o755)
  }
  return { app, log: path.join(root, 'executed.log') }
}

function runProbe(
  app: string,
  environment: Record<string, string> = {},
  cwd: string = REPO_ROOT
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [PROBE, app], {
    encoding: 'utf8',
    cwd,
    env: {
      ...process.env,
      OFFGRID_HELPER_PROBE_TIMEOUT_MS: '5000',
      ...environment
    },
    timeout: 30_000,
    killSignal: 'SIGKILL'
  })
}

describe.skipIf(!CAN_COMPILE_NATIVE)('packaged native helper execution probe', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-helper-probe-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('executes every packaged helper and accepts recognized real output', () => {
    const { app, log } = createApp(root)

    const result = runProbe(app, { OFFGRID_HELPER_FIXTURE_LOG: log })

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(fs.readFileSync(log, 'utf8').trim().split('\n').sort()).toEqual(
      [
        'computer-use-capture',
        'ffmpeg',
        'llama-server',
        'sd-cli',
        'sd-server',
        'whisper-cli'
      ].sort()
    )
    expect(result.stdout).toContain('6 packaged helpers executed successfully')
  })

  it('resolves a supplied relative app path before changing helper working directories', () => {
    const { app } = createApp(root)

    const result = runProbe(path.basename(app), {}, root)

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('6 packaged helpers executed successfully')
  })

  it('rejects a missing mandatory helper before claiming the package is usable', () => {
    const { app } = createApp(root)
    fs.rmSync(path.join(app, 'Contents', 'Resources', 'bin', 'whisper', 'whisper-cli'))

    const result = runProbe(app)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Whisper: missing bin/whisper/whisper-cli')
  })

  it('rejects a helper that loads a build-host dependency', () => {
    const { app } = createApp(root)

    const result = runProbe(app, { OFFGRID_HELPER_FIXTURE_FOREIGN: 'whisper-cli' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Whisper: loaded a build-host dependency')
    expect(result.stderr).toContain('/opt/homebrew/lib/libggml-blas.so')
  })

  it('rejects a helper that exits without recognizable version or help output', () => {
    const { app } = createApp(root)

    const result = runProbe(app, { OFFGRID_HELPER_FIXTURE_SILENT: 'ffmpeg' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('ffmpeg: produced no recognized real output')
  })

  it('rejects a helper process that exits unsuccessfully', () => {
    const { app } = createApp(root)

    const result = runProbe(app, { OFFGRID_HELPER_FIXTURE_FAIL: 'sd-cli' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('image CLI: exited status=70')
  })

  it('kills and rejects a helper that does not return before the probe timeout', () => {
    const { app } = createApp(root)

    const result = runProbe(app, {
      OFFGRID_HELPER_FIXTURE_HANG: 'llama-server',
      OFFGRID_HELPER_PROBE_TIMEOUT_MS: '100'
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('llama-server: timed out after 100ms')
  })
})
