import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ALLOWED_ASAR_ROOTS,
  ALLOWED_ASAR_OUT_ROOTS,
  REQUIRED_MAC_BUNDLE_FILES,
  assertAsarEntryInventory,
  assertAsarInventory,
  verifyBundlePair,
  verifyZipArtifact
} from '../../../scripts/lib/macos-artifact-integrity.mjs'
import verifyElectronBuilderArtifact from '../../../scripts/verify-electron-builder-artifact.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const require = createRequire(import.meta.url)
const { getMainFileMatchers } = require('app-builder-lib/out/fileMatcher')
const { getConfig } = require('app-builder-lib/out/util/config/load')
const ASAR_CLI = path.join(REPO_ROOT, 'node_modules', '@electron', 'asar', 'bin', 'asar.js')
const tempRoots: string[] = []
const FRAMEWORK_EXECUTABLE =
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'

function tempBundle(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(root)
  return path.join(root, 'Off Grid AI Desktop.app')
}

function writeBundleFixture(bundle: string): void {
  for (const relative of REQUIRED_MAC_BUNDLE_FILES) {
    const file = path.join(bundle, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `fixture:${relative}`)
    if (relative !== 'Contents/Info.plist' && relative !== 'Contents/Resources/app.asar') {
      fs.chmodSync(file, 0o755)
    }
  }
}

function matchingBundles(): { packagedBundle: string; candidateBundle: string } {
  const packagedBundle = tempBundle('offgrid-packaged-app-')
  const candidateBundle = tempBundle('offgrid-dmg-app-')
  writeBundleFixture(packagedBundle)
  fs.cpSync(packagedBundle, candidateBundle, { recursive: true })
  return { packagedBundle, candidateBundle }
}

function writeAsarArchive(archive: string, relativeFiles: string[]): void {
  fs.mkdirSync(path.dirname(archive), { recursive: true })
  const source = fs.mkdtempSync(path.join(path.dirname(archive), 'asar-source-'))
  for (const relative of relativeFiles) {
    const file = path.join(source, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `fixture:${relative}`)
  }

  const result = spawnSync(process.execPath, [ASAR_CLI, 'pack', source, archive], {
    encoding: 'utf8'
  })
  fs.rmSync(source, { recursive: true, force: true })
  expect(result.status, result.stderr).toBe(0)
}

function writeAsarFixture(bundle: string, relativeFiles: string[]): void {
  writeAsarArchive(path.join(bundle, 'Contents', 'Resources', 'app.asar'), relativeFiles)
}

describe('macOS artifact integrity', () => {
  afterEach(() => {
    while (tempRoots.length) {
      fs.rmSync(tempRoots.pop()!, { recursive: true, force: true })
    }
  })

  it('accepts a candidate bundle with the packaged manifest and required file contents', () => {
    const { packagedBundle, candidateBundle } = matchingBundles()

    expect(() => verifyBundlePair(packagedBundle, candidateBundle)).not.toThrow()
  })

  it('blocks the exact DMG failure where staging lost the Electron Framework executable', () => {
    const { packagedBundle, candidateBundle } = matchingBundles()
    fs.rmSync(path.join(candidateBundle, FRAMEWORK_EXECUTABLE))

    expect(() => verifyBundlePair(packagedBundle, candidateBundle)).toThrow(
      `candidate bundle is missing required file: ${FRAMEWORK_EXECUTABLE}`
    )
  })

  it('blocks same-size required-file corruption that a manifest-only check would miss', () => {
    const { packagedBundle, candidateBundle } = matchingBundles()
    const executable = path.join(candidateBundle, FRAMEWORK_EXECUTABLE)
    const content = fs.readFileSync(executable, 'utf8')
    fs.writeFileSync(executable, content.replace('fixture', 'corrupt'))

    expect(() => verifyBundlePair(packagedBundle, candidateBundle)).toThrow(
      `candidate bundle required file content differs: ${FRAMEWORK_EXECUTABLE}`
    )
  })

  it('blocks private local state even when it exists in both bundle trees', () => {
    const { packagedBundle, candidateBundle } = matchingBundles()
    for (const bundle of [packagedBundle, candidateBundle]) {
      const privateFile = path.join(bundle, 'Contents/Resources/.Codex/private.db')
      fs.mkdirSync(path.dirname(privateFile), { recursive: true })
      fs.writeFileSync(privateFile, 'private')
    }

    expect(() => verifyBundlePair(packagedBundle, candidateBundle)).toThrow(
      'packaged bundle contains forbidden private state: Contents/Resources/.Codex'
    )
  })

  it('accepts only the production output roots in app.asar', () => {
    const bundle = tempBundle('offgrid-asar-inventory-')
    const allowedOutputFiles = ALLOWED_ASAR_OUT_ROOTS.map((root) => `${root.slice(1)}/fixture.js`)
    const allowedRootFiles = ALLOWED_ASAR_ROOTS.filter((root) => root !== '/out').map((root) =>
      root.endsWith('.json') ? root.slice(1) : `${root.slice(1)}/fixture.js`
    )
    writeAsarFixture(bundle, [...allowedOutputFiles, ...allowedRootFiles])

    expect(() => assertAsarInventory(bundle)).not.toThrow()
  })

  it('rejects a disposable packaged-helper workspace inside app.asar', () => {
    const bundle = tempBundle('offgrid-contaminated-asar-')
    writeAsarFixture(bundle, [
      'out/main/index.js',
      'out/packaged-helpers-stale/package/mac-arm64/Off Grid AI Desktop.app/Contents/Info.plist'
    ])

    expect(() => assertAsarInventory(bundle)).toThrow(
      'app.asar contains unexpected build output: /out/packaged-helpers-stale'
    )
  })

  it('rejects private state anywhere inside app.asar', () => {
    const bundle = tempBundle('offgrid-private-asar-')
    writeAsarFixture(bundle, ['out/main/.OFFGRID/private.db'])

    expect(() => assertAsarInventory(bundle)).toThrow(
      'app.asar contains forbidden private state: /out/main/.OFFGRID'
    )
  })

  it('rejects a nested application bundle anywhere inside app.asar', () => {
    const bundle = tempBundle('offgrid-nested-app-asar-')
    writeAsarFixture(bundle, ['out/main/Nested.APP/Contents/Info.plist'])

    expect(() => assertAsarInventory(bundle)).toThrow(
      'app.asar contains a nested application bundle: /out/main/Nested.APP'
    )
  })

  it('rejects every application root outside the positive runtime allowlist', () => {
    const bundle = tempBundle('offgrid-unexpected-root-asar-')
    writeAsarFixture(bundle, ['marketing/emails/pro-earlybird/do-not-contact.csv'])

    expect(() => assertAsarInventory(bundle)).toThrow(
      'app.asar contains unexpected application root: /marketing'
    )
  })

  // Regression: @electron/asar's listPackage yields OS-separator paths — backslashes on
  // the Windows runner ("\node_modules") — so the POSIX allowlist rejected EVERY entry
  // and failed an otherwise-valid app.asar (the build-win release regression). The pure
  // entry check must normalize separators so an identical tree passes on either host,
  // WITHOUT weakening the forbidden-path checks.
  describe('assertAsarEntryInventory — cross-platform path separators', () => {
    const POSIX_TREE = [
      '/package.json',
      '/out',
      '/out/main/index.js',
      '/out/preload/index.js',
      '/out/renderer/index.html',
      '/node_modules/electron/package.json'
    ]
    const toWindows = (entries: string[]): string[] => entries.map((e) => e.replace(/\//g, '\\'))

    it('accepts a valid runtime tree with POSIX separators', () => {
      expect(() => assertAsarEntryInventory(POSIX_TREE)).not.toThrow()
    })

    it('accepts the SAME valid tree with Windows backslash separators', () => {
      expect(() => assertAsarEntryInventory(toWindows(POSIX_TREE))).not.toThrow()
    })

    it('still rejects an unexpected root delivered with Windows separators', () => {
      expect(() => assertAsarEntryInventory(['\\marketing', '\\marketing\\list.csv'])).toThrow(
        'app.asar contains unexpected application root'
      )
    })

    it('still rejects private state + build output with Windows separators', () => {
      expect(() => assertAsarEntryInventory(['\\out\\main\\.OFFGRID\\private.db'])).toThrow(
        'forbidden private state'
      )
      expect(() =>
        assertAsarEntryInventory(['\\out\\packaged-helpers-stale\\package\\x.js'])
      ).toThrow('unexpected build output')
    })

    it('still rejects a nested application bundle with Windows separators', () => {
      expect(() =>
        assertAsarEntryInventory(['\\out\\main\\Nested.APP\\Contents\\Info.plist'])
      ).toThrow('nested application bundle')
    })
  })

  it('enforces ASAR inventory on the real Windows artifact hook', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-windows-artifact-'))
    tempRoots.push(root)
    const appOutDir = path.join(root, 'win-unpacked')
    const archive = path.join(appOutDir, 'resources', 'app.asar')
    writeAsarArchive(archive, [
      'out/main/index.js',
      'marketing/emails/pro-earlybird/do-not-contact.csv'
    ])
    const event = {
      file: path.join(root, 'OffGrid-0.0.39-setup.exe'),
      arch: 1,
      target: { outDir: root },
      packager: {
        computeAppOutDir: (): string => appOutDir,
        appInfo: { productFilename: 'Off Grid AI Desktop' }
      }
    }

    await expect(verifyElectronBuilderArtifact(event)).rejects.toThrow(
      'app.asar contains unexpected application root: /marketing'
    )
  })

  it.skipIf(process.platform !== 'darwin')(
    'enforces ASAR inventory through the real updater ZIP verification seam',
    async () => {
      const { packagedBundle, candidateBundle } = matchingBundles()
      const contaminated = [
        'out/main/index.js',
        'marketing/emails/pro-earlybird/do-not-contact.csv'
      ]
      writeAsarFixture(packagedBundle, contaminated)
      writeAsarFixture(candidateBundle, contaminated)
      const archive = path.join(path.dirname(candidateBundle), 'contaminated-updater.zip')
      const create = spawnSync('/usr/bin/ditto', [
        '-c',
        '-k',
        '--keepParent',
        candidateBundle,
        archive
      ])
      expect(create.status, create.stderr?.toString()).toBe(0)

      await expect(verifyZipArtifact(archive, packagedBundle)).rejects.toThrow(
        'app.asar contains unexpected application root: /marketing'
      )
    }
  )

  it.skipIf(process.platform !== 'darwin')(
    'extracts the real updater ZIP and rejects required-file corruption',
    async () => {
      const { packagedBundle, candidateBundle } = matchingBundles()
      const executable = path.join(candidateBundle, FRAMEWORK_EXECUTABLE)
      const content = fs.readFileSync(executable, 'utf8')
      fs.writeFileSync(executable, content.replace('fixture', 'corrupt'))
      const archive = path.join(path.dirname(candidateBundle), 'updater.zip')
      const create = spawnSync('/usr/bin/ditto', [
        '-c',
        '-k',
        '--keepParent',
        candidateBundle,
        archive
      ])
      expect(create.status, create.stderr?.toString()).toBe(0)

      await expect(verifyZipArtifact(archive, packagedBundle)).rejects.toThrow(
        `candidate bundle required file content differs: ${FRAMEWORK_EXECUTABLE}`
      )
    }
  )

  it('pins a fixed builder with explicit image headroom for the large macOS bundle', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
    ) as {
      devDependencies: { 'electron-builder': string }
    }
    const builderVersion = packageJson.devDependencies['electron-builder']
    const [major = 0, minor = 0, patch = 0] = builderVersion.split('.').map(Number)
    const numericVersion = major * 1_000_000 + minor * 1_000 + patch
    const minimumFixedVersion = 26 * 1_000_000 + 15 * 1_000 + 3
    const builderConfig = fs.readFileSync(path.join(REPO_ROOT, 'electron-builder.yml'), 'utf8')
    const imageSizeGiB = Number(builderConfig.match(/^\s+size:\s+(\d+)g$/m)?.[1])

    expect(builderVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(numericVersion).toBeGreaterThanOrEqual(minimumFixedVersion)
    expect(imageSizeGiB).toBeGreaterThanOrEqual(5)
    expect(builderConfig).toMatch(/^\s+shrink:\s+true$/m)
    expect(builderConfig).toContain("- 'out/**/*'")
    expect(builderConfig).toContain("- 'package.json'")
    expect(builderConfig).toContain('extends: scripts/config/electron-builder-runtime.yml')
    expect(builderConfig).toContain("'!out/packaged-helpers-*/**'")
  })

  it('advertises the same minimum macOS version required by the bundled chat engine', () => {
    const builderConfig = fs.readFileSync(path.join(REPO_ROOT, 'electron-builder.yml'), 'utf8')
    const llamaBuild = fs.readFileSync(path.join(REPO_ROOT, 'scripts/build-llama.sh'), 'utf8')
    const appMinimum = builderConfig.match(
      /^\s+minimumSystemVersion:\s+['"]?([^'"\s]+)['"]?$/m
    )?.[1]
    const llamaMinimum = llamaBuild.match(/TARGET="\$\{MACOS_DEPLOYMENT_TARGET:-([^}]+)\}"/)?.[1]

    expect(appMinimum).toBeDefined()
    expect(appMinimum).toBe(llamaMinimum)
  })

  it('declares the local-network purpose and Bonjour service in packaged macOS metadata', async () => {
    const loaded = await getConfig(
      {
        packageKey: 'build',
        configFilename: 'electron-builder',
        projectDir: REPO_ROOT,
        packageMetadata: null
      },
      path.join(REPO_ROOT, 'electron-builder.yml')
    )
    const extendInfo = loaded.result.mac?.extendInfo

    expect(Array.isArray(extendInfo)).toBe(false)
    expect(extendInfo).toMatchObject({
      NSLocalNetworkUsageDescription:
        'Off Grid AI Desktop uses your local network to find and sync directly with your devices. Sync traffic is encrypted and no Off Grid server receives it.',
      NSBonjourServices: ['_offgrid._tcp', '_offgrid-sync._tcp', '_offgrid-sync._udp']
    })
  })

  it('uses the real production matcher to exclude repository data and development modules', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-builder-matcher-'))
    tempRoots.push(root)
    const relativeFiles = [
      'out/main/index.js',
      'package.json',
      'marketing/emails/pro-earlybird/do-not-contact.csv',
      'node_modules/vitest/package.json',
      'node_modules/electron/dist/Electron.app/Contents/Info.plist'
    ]
    for (const relative of relativeFiles) {
      const file = path.join(root, relative)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, relative)
    }

    const loaded = await getConfig(
      {
        packageKey: 'build',
        configFilename: 'electron-builder',
        projectDir: REPO_ROOT,
        packageMetadata: null
      },
      path.join(REPO_ROOT, 'electron-builder.yml')
    )
    const info = {
      config: loaded.result,
      projectDir: root,
      buildResourcesDir: 'build',
      isPrepackedAppAsar: false,
      debugLogger: { isEnabled: false }
    }
    const [matcher] = getMainFileMatchers(
      root,
      path.join(root, 'destination'),
      (value: string): string => value,
      {},
      { info },
      path.join(root, 'dist'),
      false
    )
    const filter = matcher.createFilter()
    const admitted = (relative: string): boolean => {
      const absolute = path.join(root, relative)
      return filter(absolute, fs.lstatSync(absolute))
    }

    expect(admitted('out/main/index.js')).toBe(true)
    expect(admitted('package.json')).toBe(true)
    expect(admitted('marketing/emails/pro-earlybird/do-not-contact.csv')).toBe(false)
    expect(admitted('node_modules/vitest/package.json')).toBe(false)
    expect(admitted('node_modules/electron/dist/Electron.app/Contents/Info.plist')).toBe(false)
  })

  it('ad-hoc signs local bundles after fuses while keeping artifact verification strict', () => {
    const localBuild = fs.readFileSync(path.join(REPO_ROOT, 'scripts/build-mac-local.sh'), 'utf8')
    const artifactHook = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts/verify-electron-builder-artifact.mjs'),
      'utf8'
    )

    expect(localBuild.match(/-c\.mac\.identity=-/g)).toHaveLength(2)
    expect(localBuild).toContain('export OFFGRID_ALLOW_LOCAL_ARTIFACT=1')
    expect(localBuild).toContain('export OFFGRID_LOCAL_PUBLISH_POLICY=never')
    expect(localBuild.match(/^\s+--publish never$/gm)).toHaveLength(2)
    expect(localBuild).toContain('bash scripts/build-meeting-recorder.sh')
    expect(localBuild).toContain('bash scripts/build-dictation-hotkey.sh')
    expect(localBuild).toContain(
      'cp scripts/meeting-recorder/meeting-recorder resources/bin/meeting-recorder'
    )
    expect(localBuild).toContain(
      'cp scripts/dictation-hotkey/dictation-hotkey resources/bin/dictation-hotkey'
    )
    expect(artifactHook).not.toContain('OFFGRID_ALLOW_UNSIGNED_ARTIFACT')
    expect(artifactHook).toContain("artifact.endsWith('.zip')")
    expect(artifactHook).toContain('verifyReleaseZipArtifact')
  })
})
