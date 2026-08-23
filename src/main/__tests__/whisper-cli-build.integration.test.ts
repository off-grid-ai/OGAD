import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const BUILD_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-whisper-cli.sh')
const tempRoots: string[] = []

type FixtureMode =
  | 'healthy'
  | 'foreign-homebrew'
  | 'missing-rpath'
  | 'newer-minos'
  | 'non-real-rpath'

function writeExecutable(file: string, source: string): void {
  fs.writeFileSync(file, source, { mode: 0o755 })
}

function runBuild(mode: FixtureMode): ReturnType<typeof spawnSync> & {
  sandbox: string
  cmakeLog: string
  otoolLog: string
} {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-whisper-cli-build-'))
  tempRoots.push(sandbox)
  const fakeBin = path.join(sandbox, 'fake-bin')
  const cmakeLog = path.join(sandbox, 'cmake.log')
  const otoolLog = path.join(sandbox, 'otool.log')
  fs.mkdirSync(fakeBin)

  writeExecutable(
    path.join(fakeBin, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "${'$'}{!#}"
`
  )
  writeExecutable(
    path.join(fakeBin, 'cmake'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "${'$'}*" >> "${cmakeLog}"
if [ "${'$'}1" != "--build" ]; then exit 0; fi
mkdir -p build/bin build/lib
printf '#!/usr/bin/env bash\nprintf "usage: whisper-cli [options] file\\noptions:\\n"\n' > build/bin/whisper-cli
chmod +x build/bin/whisper-cli
for spec in 'libwhisper 1.7.4 1' 'libggml 0.15.2 0' 'libggml-base 0.15.2 0'; do
  set -- ${'$'}spec
  printf 'fixture dylib for %s\n' "${'$'}1" > "build/lib/${'$'}1.${'$'}2.dylib"
  ln -sfn "${'$'}1.${'$'}2.dylib" "build/lib/${'$'}1.${'$'}3.dylib"
done
`
  )
  writeExecutable(
    path.join(fakeBin, 'cp'),
    `#!/usr/bin/env bash
set -euo pipefail
destination="${'$'}{!#}"
source_path=""
for argument in "${'$'}@"; do
  if [ "${'$'}argument" != "${'$'}destination" ] && [ "${'$'}argument" != "-f" ]; then
    source_path="${'$'}argument"
  fi
done
if [ "${mode}" = "non-real-rpath" ] && [ -L "${'$'}source_path" ]; then
  /bin/cp -Pf "${'$'}source_path" "${'$'}destination"
else
  /bin/cp "${'$'}@"
fi
`
  )
  writeExecutable(path.join(fakeBin, 'sysctl'), '#!/usr/bin/env bash\nprintf "4\\n"\n')
  const minos = mode === 'newer-minos' ? '13.1' : '13.0'
  writeExecutable(
    path.join(fakeBin, 'otool'),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "${'$'}1" = "-l" ]; then
  printf 'Load command 1\n      cmd LC_BUILD_VERSION\n    minos ${minos}\n'
  # The staged binary carries the @loader_path rpath install_name_tool adds, because the script
  # GATES on it: without one the dylibs sitting right beside whisper-cli are unreachable to dyld,
  # which is the "nothing happened" voice-note bug. A fake that never reports a load command the
  # script checks makes the script fail for a reason the test is not about.
  printf 'Load command 2\n          cmd LC_RPATH\n      cmdsize 32\n         path @loader_path (offset 12)\n'
  exit 0
fi
file="${'$'}2"
printf '%s\n' "${'$'}file" >> "${otoolLog}"
printf '%s:\n' "${'$'}file"
case "${'$'}{file##*/}" in
  whisper-cli)
    printf '    @rpath/libwhisper.1.dylib (compatibility version 1.0.0, current version 1.0.0)\n'
    printf '    @rpath/libggml.0.dylib (compatibility version 0.0.0, current version 0.0.0)\n'
    ;;
  libwhisper.*.dylib)
    printf '    @rpath/libggml.0.dylib (compatibility version 0.0.0, current version 0.0.0)\n'
    if [ "${mode}" = "missing-rpath" ]; then
      printf '    @rpath/libmissing.0.dylib (compatibility version 0.0.0, current version 0.0.0)\n'
    fi
    ;;
  libggml.*.dylib)
    printf '    @rpath/libggml-base.0.dylib (compatibility version 0.0.0, current version 0.0.0)\n'
    ;;
  libggml-base.*.dylib)
    if [ "${mode}" = "foreign-homebrew" ]; then
      printf '    /opt/homebrew/opt/libomp/lib/libomp.dylib (compatibility version 5.0.0, current version 5.0.0)\n'
    fi
    ;;
esac
printf '    /usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n'
`
  )

  const result = spawnSync('bash', [BUILD_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      MACOS_DEPLOYMENT_TARGET: '13.0',
      OFFGRID_BUILD_ROOT: sandbox,
      WHISPER_REF: 'fixture-ref'
    },
    encoding: 'utf8'
  })
  return Object.assign(result, { sandbox, cmakeLog, otoolLog })
}

describe('pinned Whisper CLI build and staging', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it('disables host-discovered dependencies and stages a closed real-file graph', () => {
    const result = runBuild('healthy')
    const destination = path.join(result.sandbox, 'resources', 'bin', 'whisper')
    const cmake = fs.readFileSync(result.cmakeLog, 'utf8')
    const staged = fs.readdirSync(destination)
    const audited = fs
      .readFileSync(result.otoolLog, 'utf8')
      .trim()
      .split('\n')
      .map((file) => path.basename(file))

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(cmake).toContain('-DGGML_OPENMP=OFF')
    expect(cmake).toContain('-DGGML_BLAS=OFF')
    expect(cmake).toContain('-DBUILD_SHARED_LIBS=ON')
    expect(cmake).toContain('--target whisper-cli')
    expect(result.stdout).toContain('built whisper-cli minos=13.0 (want <= 13.0)')
    expect(result.stdout).toContain('no foreign deps, all @rpath libs present')
    expect(fs.statSync(path.join(destination, 'whisper-cli')).mode & 0o111).not.toBe(0)
    for (const name of ['libwhisper.1.dylib', 'libggml.0.dylib', 'libggml-base.0.dylib']) {
      const stat = fs.lstatSync(path.join(destination, name))
      expect(stat.isFile(), name).toBe(true)
      expect(stat.isSymbolicLink(), name).toBe(false)
    }
    expect(audited).toEqual(expect.arrayContaining(staged))
  })

  it('rejects a Homebrew OpenMP dependency', () => {
    const result = runBuild('foreign-homebrew')
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status).not.toBe(0)
    expect(output).toContain('engine links non-system libs')
    expect(output).toContain('/opt/homebrew/opt/libomp/lib/libomp.dylib')
  })

  it('rejects a missing exact @rpath dependency name', () => {
    const result = runBuild('missing-rpath')
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status).not.toBe(0)
    expect(output).toContain('missing or not staged as real files: libmissing.0.dylib')
  })

  it('rejects an @rpath dependency staged as a symlink', () => {
    const result = runBuild('non-real-rpath')
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status).not.toBe(0)
    expect(output).toContain('missing or not staged as real files')
  })

  it('rejects a minor deployment target newer than the release floor', () => {
    const result = runBuild('newer-minos')
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status).not.toBe(0)
    expect(output).toContain('minos 13.1 exceeds target 13.0')
  })

  it('keeps release and local builds on the same pinned native-engine scripts', () => {
    const release = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8')
    const local = fs.readFileSync(path.join(REPO_ROOT, 'scripts/build-mac-local.sh'), 'utf8')
    // No LLAMA_REF here on purpose. The version has one owner - package.json `offgrid.llamaRef` - and a caller that
    // passes its own would silently build a different engine than the Windows fetch pulls, which is the
    // drift this test exists to catch.
    const llamaBuild = 'MACOS_DEPLOYMENT_TARGET=13.0 bash scripts/build-llama.sh'
    const whisperBuild =
      'MACOS_DEPLOYMENT_TARGET=13.0 WHISPER_REF=v1.7.4 bash scripts/build-whisper-cli.sh'

    for (const source of [release, local]) {
      expect(source).toContain(llamaBuild)
      expect(source).toContain(whisperBuild)
    }
    for (const source of [release, local]) {
      expect(source).not.toMatch(/LLAMA_REF=/)
    }
    expect(local).toContain('bash scripts/fetch-parakeet.sh')
    expect(local).toContain('node scripts/probe-packaged-helpers.mjs "$app_dir"')
    expect(local.match(/^\s+verify_packaged_helpers$/gm)).toHaveLength(2)
    expect(local.indexOf('stage_native_helpers')).toBeLessThan(local.indexOf('case "$TARGET"'))
    expect(local.lastIndexOf('verify_packaged_helpers')).toBeLessThan(
      local.indexOf('==> Done. DMGs:')
    )
  })
})
