import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  REQUIRED_EXECUTABLE_FILES,
  REQUIRED_MAC_BUNDLE_FILES
} from '../../../scripts/lib/macos-artifact-integrity.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../..')
const VERIFIER = path.join(REPO_ROOT, 'scripts', 'smoke-dmg-install.sh')
const CAN_MOUNT_DMG = process.platform === 'darwin' && fs.existsSync('/usr/bin/hdiutil')
const DMG_TEST_TIMEOUT_MS = 120_000
const HELPER_PROBE = path.join(REPO_ROOT, 'scripts', 'probe-packaged-helpers.mjs')

const installHelperFixtures = (app: string): void => {
  const script = `#!/usr/bin/env bash
set -euo pipefail
case "$(basename "$0")" in
  llama-server) printf 'usage: llama-server [options]\\n' ;;
  ffmpeg) printf 'ffmpeg version 6.0-fixture\\n' ;;
  whisper-cli) printf 'usage: whisper-cli [options] file\\noptions:\\n' ;;
  computer-use-capture) printf 'usage: computer-use-capture <output.png> <display-id> <excluded-window-id> <width> <height>\\n' ;;
  sd-server) printf 'stable-diffusion.cpp version fixture\\nUsage: sd-server [options]\\n' ;;
  sd-cli) printf 'stable-diffusion.cpp version fixture\\nUsage: sd-cli [options]\\n' ;;
  *) exit 64 ;;
esac
`
  for (const relative of [
    'bin/llama/llama-server',
    'bin/ffmpeg',
    'bin/whisper/whisper-cli',
    'bin/computer-use-capture',
    'bin/sd/sd-server',
    'bin/sd/sd-cli'
  ]) {
    const target = path.join(app, 'Contents', 'Resources', relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, script)
    fs.chmodSync(target, 0o755)
  }
}

const makeFakeDmgBoundary = (root: string): string => {
  const boundary = path.join(root, 'fake-hdiutil.sh')
  fs.writeFileSync(
    boundary,
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  attach)
    mount_point=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = -mountpoint ]; then mount_point="$2"; break; fi
      shift
    done
    test -n "$mount_point"
    /usr/bin/ditto "$FAKE_DMG_SOURCE" "$mount_point"
    ;;
  detach)
    mount_point="$2"
    find "$mount_point" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    ;;
  *) exit 64 ;;
esac
`
  )
  fs.chmodSync(boundary, 0o755)
  return boundary
}

const makeFakeDmg = (root: string): string => {
  const dmg = path.join(root, 'fixture.dmg')
  fs.writeFileSync(dmg, 'hdiutil boundary fixture')
  return dmg
}

const makeHangingDmgBoundary = (root: string): string => {
  const boundary = path.join(root, 'hanging-hdiutil.sh')
  fs.writeFileSync(
    boundary,
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  attach)
    mount_point=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = -mountpoint ]; then mount_point="$2"; break; fi
      shift
    done
    printf 'attach\n' >> "$FAKE_HDIUTIL_LOG"
    mkdir -p "$mount_point"
    touch "$mount_point/attach-populated-before-timeout"
    exec /bin/sleep 5
    ;;
  detach)
    printf 'detach\n' >> "$FAKE_HDIUTIL_LOG"
    find "$2" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    ;;
  *) exit 64 ;;
esac
`
  )
  fs.chmodSync(boundary, 0o755)
  return boundary
}

const createAppBundle = (root: string, appName = 'Off Grid AI Desktop.app'): string => {
  const app = path.join(root, appName)
  const contents = path.join(app, 'Contents')
  const executable = path.join(contents, 'MacOS', 'Off Grid AI Desktop')
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(
    path.join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Off Grid AI Desktop</string>
  <key>CFBundleIdentifier</key><string>co.getoffgridai.desktop.smoke-fixture</string>
  <key>CFBundleName</key><string>Off Grid AI Desktop</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`
  )
  fs.writeFileSync(executable, '#!/usr/bin/env bash\nexit 0\n')
  fs.chmodSync(executable, 0o755)
  fs.writeFileSync(path.join(contents, 'fixture-marker.txt'), 'copied-from-mounted-dmg')
  installHelperFixtures(app)
  return app
}

const runVerifier = (
  dmg: string,
  environment: Record<string, string | undefined> = {}
): ReturnType<typeof spawnSync> =>
  spawnSync('bash', [VERIFIER, dmg], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    timeout: 20_000,
    killSignal: 'SIGKILL'
  })

const makeReleaseShapedBundle = (root: string): string => {
  const nativeFixture = path.join(path.dirname(root), 'native-fixture')
  const compile = spawnSync('/usr/bin/clang', ['-x', 'c', '-', '-o', nativeFixture], {
    encoding: 'utf8',
    input: `#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc > 0 && strstr(argv[0], "llama-server")) {
    puts("usage: llama-server [options]");
  } else if (argc > 0 && strstr(argv[0], "computer-use-capture")) {
    puts("usage: computer-use-capture <output.png> <display-id> <excluded-window-id> <width> <height>");
  }
  return 0;
}
`
  })
  if (compile.status !== 0) throw new Error(compile.stderr)

  const app = createAppBundle(root)
  fs.rmSync(path.join(app, 'Contents/fixture-marker.txt'))
  for (const relative of REQUIRED_MAC_BUNDLE_FILES) {
    const file = path.join(app, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (REQUIRED_EXECUTABLE_FILES.has(relative)) {
      fs.copyFileSync(nativeFixture, file)
      fs.chmodSync(file, 0o755)
    } else if (fs.existsSync(file)) {
      continue
    } else {
      fs.writeFileSync(file, `fixture:${relative}`)
    }
  }
  const framework = path.join(app, 'Contents/Frameworks/Electron Framework.framework')
  const frameworkResources = path.join(framework, 'Versions/A/Resources')
  fs.mkdirSync(frameworkResources, { recursive: true })
  fs.writeFileSync(
    path.join(frameworkResources, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Electron Framework</string>
  <key>CFBundleIdentifier</key><string>co.getoffgridai.desktop.framework-fixture</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleVersion</key><string>1</string>
</dict></plist>
`
  )
  fs.symlinkSync('A', path.join(framework, 'Versions/Current'))
  fs.symlinkSync('Versions/Current/Electron Framework', path.join(framework, 'Electron Framework'))
  fs.symlinkSync('Versions/Current/Resources', path.join(framework, 'Resources'))
  return app
}

const codesign = (...args: string[]): ReturnType<typeof spawnSync> =>
  spawnSync('/usr/bin/codesign', args, { encoding: 'utf8' })

const textSectionOffset = (executable: string): number => {
  const result = spawnSync('/usr/bin/otool', ['-l', executable], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  const offset = result.stdout.match(/sectname __text[\s\S]*?\boffset (\d+)/)?.[1]
  if (!offset) throw new Error(`No __text offset in ${executable}`)
  return Number(offset)
}

const signReleaseShapedBundle = (app: string): ReturnType<typeof spawnSync>[] => {
  const framework = path.join(app, 'Contents/Frameworks/Electron Framework.framework')
  return [
    ...[...REQUIRED_EXECUTABLE_FILES]
      .filter(
        (relative) =>
          relative.startsWith('Contents/Resources/bin/') || relative.includes('.framework/')
      )
      .map((relative) => codesign('--force', '--sign', '-', path.join(app, relative))),
    codesign('--force', '--sign', '-', framework),
    codesign('--force', '--sign', '-', app)
  ]
}

describe.skipIf(!CAN_MOUNT_DMG)('DMG installed-copy smoke verifier', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-dmg-verifier-test-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it(
    'copies the mounted app outside /Applications, detaches, then runs smoke',
    () => {
      const source = path.join(root, 'source')
      fs.mkdirSync(source)
      createAppBundle(source)
      const dmg = makeFakeDmg(root)
      const hdiutil = makeFakeDmgBoundary(root)

      const capture = path.join(root, 'smoke-capture.txt')
      const runner = path.join(root, 'assert-installed-copy.sh')
      fs.writeFileSync(
        runner,
        `#!/usr/bin/env bash
set -euo pipefail
: "\${APP:?missing copied app path}"
: "\${OFFGRID_DMG_MOUNT_POINT:?missing mount point}"
case "$APP" in /Applications/*) exit 21 ;; esac
test -x "$APP/Contents/MacOS/Off Grid AI Desktop"
test "$(cat "$APP/Contents/fixture-marker.txt")" = copied-from-mounted-dmg
test ! -e "$OFFGRID_DMG_MOUNT_POINT/Off Grid AI Desktop.app"
printf '%s\n' "$APP" > "$DMG_SMOKE_CAPTURE"
`
      )

      const result = runVerifier(dmg, {
        DMG_HDIUTIL: hdiutil,
        FAKE_DMG_SOURCE: source,
        DMG_SMOKE_RUNNER: runner,
        DMG_SMOKE_CAPTURE: capture
      })

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      const installedApp = fs.readFileSync(capture, 'utf8').trim()
      expect(installedApp).toContain('/offgrid-dmg-install.')
      expect(installedApp).toMatch(/\/install\/Off Grid AI Desktop\.app$/)
      expect(installedApp.startsWith('/Applications/')).toBe(false)
      expect(fs.existsSync(installedApp)).toBe(false)
    },
    DMG_TEST_TIMEOUT_MS
  )

  it(
    'uses the isolated packaged UI smoke by default with the copied executable',
    () => {
      const source = path.join(root, 'source')
      fs.mkdirSync(source)
      createAppBundle(source)
      const dmg = makeFakeDmg(root)
      const hdiutil = makeFakeDmgBoundary(root)

      const capture = path.join(root, 'default-smoke-capture.txt')
      const binDir = path.join(root, 'bin')
      fs.mkdirSync(binDir)
      fs.writeFileSync(
        path.join(binDir, 'node'),
        `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "$TIMEOUT_RUNNER" ]; then
  shift
  exec "$REAL_NODE" "$TIMEOUT_RUNNER" "$@"
fi
case "$1" in
  "$EXPECTED_HELPER_PROBE")
    exec "$REAL_NODE" "$EXPECTED_HELPER_PROBE" "\${@:2}"
    ;;
  "$EXPECTED_SMOKE_TEST")
    : "\${APP_BIN:?missing copied executable path}"
    : "\${OFFGRID_DMG_MOUNT_POINT:?missing mount point}"
    case "$APP_BIN" in /Applications/*) exit 21 ;; esac
    test -x "$APP_BIN"
    test ! -e "$OFFGRID_DMG_MOUNT_POINT/Off Grid AI Desktop.app"
    printf 'ui:%s\n' "$APP_BIN" >> "$DMG_SMOKE_CAPTURE"
    ;;
  "$EXPECTED_LICENSE_SMOKE")
    case "$2" in /Applications/*) exit 21 ;; esac
    test -x "$2"
    printf 'license:%s\n' "$2" >> "$DMG_SMOKE_CAPTURE"
    ;;
  *) exit 64 ;;
esac
`
      )
      fs.chmodSync(path.join(binDir, 'node'), 0o755)

      const result = runVerifier(dmg, {
        DMG_HDIUTIL: hdiutil,
        FAKE_DMG_SOURCE: source,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        REAL_NODE: process.execPath,
        TIMEOUT_RUNNER: path.join(REPO_ROOT, 'scripts', 'exec-with-timeout.mjs'),
        EXPECTED_HELPER_PROBE: HELPER_PROBE,
        EXPECTED_SMOKE_TEST: path.join(REPO_ROOT, 'scripts', 'smoke-test.mjs'),
        EXPECTED_LICENSE_SMOKE: path.join(REPO_ROOT, 'scripts', 'smoke-license-gate.mjs'),
        DMG_SMOKE_CAPTURE: capture
      })

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      const calls = fs.readFileSync(capture, 'utf8').trim().split('\n')
      expect(calls).toHaveLength(2)
      const installedExecutable = calls[0]!.replace(/^ui:/, '')
      expect(calls[1]).toBe(`license:${installedExecutable}`)
      expect(installedExecutable).toMatch(
        /\/install\/Off Grid AI Desktop\.app\/Contents\/MacOS\/Off Grid AI Desktop$/
      )
      expect(fs.existsSync(installedExecutable)).toBe(false)
    },
    DMG_TEST_TIMEOUT_MS
  )

  it(
    'rejects an ambiguous image instead of silently choosing one app',
    () => {
      const source = path.join(root, 'source')
      fs.mkdirSync(source)
      createAppBundle(source)
      createAppBundle(source, 'Unexpected Copy.app')
      const dmg = makeFakeDmg(root)
      const hdiutil = makeFakeDmgBoundary(root)

      const runner = path.join(root, 'must-not-run.sh')
      fs.writeFileSync(runner, '#!/usr/bin/env bash\nexit 99\n')
      const result = runVerifier(dmg, {
        DMG_HDIUTIL: hdiutil,
        FAKE_DMG_SOURCE: source,
        DMG_SMOKE_RUNNER: runner
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('expected exactly one .app in the DMG, found 2')
    },
    DMG_TEST_TIMEOUT_MS
  )

  it('rejects a missing DMG before creating or mounting anything', () => {
    const result = runVerifier(path.join(root, 'missing.dmg'))

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('pass an existing DMG path')
  })

  it('refuses a custom DiskImages boundary when release trust is required', () => {
    const dmg = makeFakeDmg(root)
    const hdiutil = makeFakeDmgBoundary(root)

    const result = runVerifier(dmg, {
      DMG_HDIUTIL: hdiutil,
      OFFGRID_REQUIRE_RELEASE_TRUST: '1'
    })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('release verification cannot override /usr/bin/hdiutil')
  })

  it('detaches after attach populates the mount and then exceeds its deadline', () => {
    const dmg = makeFakeDmg(root)
    const hdiutil = makeHangingDmgBoundary(root)
    const log = path.join(root, 'hdiutil.log')

    const result = runVerifier(dmg, {
      DMG_COMMAND_TIMEOUT_MS: '1000',
      DMG_HDIUTIL: hdiutil,
      FAKE_HDIUTIL_LOG: log
    })

    expect(result.status).toBe(124)
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual(['attach', 'detach'])
  })

  it(
    're-signs after a fuse-like mutation and preserves strict signatures through install',
    () => {
      const source = path.join(root, 'source')
      fs.mkdirSync(source)
      const app = makeReleaseShapedBundle(source)
      const framework = path.join(
        app,
        'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'
      )

      for (const result of signReleaseShapedBundle(app)) {
        expect(result.status, String(result.stderr)).toBe(0)
      }
      expect(codesign('--verify', '--deep', '--strict', app).status).toBe(0)

      const descriptor = fs.openSync(framework, 'r+')
      const changedByte = Buffer.alloc(1)
      const mutationOffset = textSectionOffset(framework) + 4
      fs.readSync(descriptor, changedByte, 0, 1, mutationOffset)
      changedByte[0] = changedByte[0]! ^ 1
      fs.writeSync(descriptor, changedByte, 0, 1, mutationOffset)
      fs.closeSync(descriptor)
      expect(codesign('--verify', '--deep', '--strict', app).status).not.toBe(0)

      for (const result of signReleaseShapedBundle(app)) {
        expect(result.status, String(result.stderr)).toBe(0)
      }
      expect(codesign('--verify', '--deep', '--strict', app).status).toBe(0)

      const dmg = makeFakeDmg(root)
      const hdiutil = makeFakeDmgBoundary(root)
      const runner = path.join(root, 'verify-installed-signature.sh')
      fs.writeFileSync(
        runner,
        '#!/usr/bin/env bash\nset -euo pipefail\n/usr/bin/codesign --verify --deep --strict "$APP"\n'
      )

      const result = runVerifier(dmg, {
        DMG_HDIUTIL: hdiutil,
        FAKE_DMG_SOURCE: source,
        DMG_REFERENCE_APP: app,
        DMG_SMOKE_RUNNER: runner
      })

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    },
    DMG_TEST_TIMEOUT_MS
  )
})
