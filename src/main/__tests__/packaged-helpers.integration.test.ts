import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configureRuntime, binRoots } from '../runtime-env'
import { ffmpegBin } from '../transcription/whisper-cli'
import { withElectronViteBuildLock } from './electron-vite-build-lock'

const root = path.resolve(import.meta.dirname, '../../..')
const electronVite = path.join(root, 'node_modules', '.bin', 'electron-vite')
const electronBuilder = path.join(root, 'node_modules', '.bin', 'electron-builder')
const runtimeBuilderConfig = path.join(root, 'scripts', 'config', 'electron-builder-runtime.yml')
const execFileAsync = promisify(execFile)
const PACKAGE_TIMEOUT_MS = 120_000

let sandbox = ''
let resourcesDir = ''

function yamlPath(value: string): string {
  return JSON.stringify(value)
}

function filesNamed(dir: string, extension: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => entry.name)
    .sort()
}

function assertPackagedExecutable(file: string): void {
  const stat = fs.statSync(file)
  const prefix = fs.readFileSync(file).subarray(0, 200).toString('utf8')

  expect(stat.isFile(), file).toBe(true)
  expect(stat.size, file).toBeGreaterThan(200)
  expect(stat.mode & 0o111, file).not.toBe(0)
  expect(prefix, file).not.toContain('git-lfs.github.com/spec')
}

function packagedResources(packageOut: string): string {
  if (process.platform !== 'darwin') {
    const unpacked = process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked'
    return path.join(packageOut, unpacked, 'resources')
  }

  const platformDir = fs
    .readdirSync(packageOut, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
  if (!platformDir) throw new Error(`electron-builder produced no mac directory in ${packageOut}`)

  const app = fs
    .readdirSync(path.join(packageOut, platformDir.name), { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
  if (!app) throw new Error(`electron-builder produced no .app in ${platformDir.name}`)
  return path.join(packageOut, platformDir.name, app.name, 'Contents', 'Resources')
}

describe.sequential('packaged helper artifact', () => {
  beforeAll(async () => {
    // electron-builder refuses ASAR inputs from macOS's /tmp -> /private/tmp alias as
    // unsafe. Keep this disposable package workspace under the ignored out/ directory.
    fs.mkdirSync(path.join(root, 'out'), { recursive: true })
    sandbox = fs.mkdtempSync(path.join(root, 'out', 'packaged-helpers-'))
    const bundleOut = path.join(sandbox, 'bundle')
    const packageOut = path.join(sandbox, 'package')
    const testConfig = path.join(sandbox, 'electron-builder.test.yml')

    await withElectronViteBuildLock(root, () =>
      execFileAsync(electronVite, ['build', '--outDir', bundleOut, '--logLevel', 'error'], {
        cwd: root,
        env: { ...process.env, OFFGRID_FORCE_CORE: '1' },
        maxBuffer: 10 * 1024 * 1024,
        timeout: PACKAGE_TIMEOUT_MS
      }).then(() => undefined)
    )

    // Inherit the same runtime-resource contract as production. Only redirect the
    // already-built app bundle and output into the isolated workspace.
    // Runtime dependency packaging is covered by the packaged launch checks (#1/#2);
    // this focused artifact test excludes node_modules to keep helper placement fast.
    fs.writeFileSync(
      testConfig,
      `extends: ${yamlPath(runtimeBuilderConfig)}
appId: co.getoffgridai.desktop.packaged-helper-test
productName: Off Grid AI Desktop
electronDist: ${yamlPath(path.join(root, 'node_modules', 'electron', 'dist'))}
directories:
  app: ${yamlPath(root)}
  output: ${yamlPath(packageOut)}
files:
  - from: ${yamlPath(bundleOut)}
    to: out
    filter:
      - '**/*'
  - package.json
  - '!node_modules/**'
mac:
  extraResources:
    - from: ${yamlPath(path.join(root, '..', 'executorch-speech', 'native', 'bin', 'executorch-speech'))}
      to: bin/executorch-speech
  target:
    - dir
  notarize: false
`
    )

    const platformFlag =
      process.platform === 'darwin' ? '--mac' : process.platform === 'win32' ? '--win' : '--linux'
    await execFileAsync(
      electronBuilder,
      [platformFlag, 'dir', '--config', testConfig, '--publish', 'never'],
      {
        cwd: root,
        env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
        maxBuffer: 10 * 1024 * 1024,
        timeout: PACKAGE_TIMEOUT_MS
      }
    )

    resourcesDir = packagedResources(packageOut)
    configureRuntime({ binRoots: [path.join(resourcesDir, 'bin')] })
  }, PACKAGE_TIMEOUT_MS * 2)

  afterAll(() => {
    configureRuntime({ binRoots: undefined })
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true })
  })

  it('places llama-server, ffmpeg, and Whisper at the paths used by packaged runtime resolution', () => {
    const [binRoot] = binRoots()
    expect(binRoot).toBe(path.join(resourcesDir, 'bin'))

    const llamaServer = path.join(binRoot!, 'llama', 'llama-server')
    const whisperCli = path.join(binRoot!, 'whisper', 'whisper-cli')
    const ffmpeg = path.join(binRoot!, 'ffmpeg')

    assertPackagedExecutable(llamaServer)
    assertPackagedExecutable(whisperCli)
    assertPackagedExecutable(ffmpeg)
    expect(ffmpegBin()).toBe(ffmpeg)
  })

  it('copies every staged llama and Whisper dylib into the packaged runtime directories', () => {
    for (const helper of ['llama', 'whisper']) {
      const stagedDir = path.join(root, 'resources', 'bin', helper)
      const packagedDir = path.join(resourcesDir, 'bin', helper)
      const stagedDylibs = filesNamed(stagedDir, '.dylib')

      expect(stagedDylibs.length, `${helper} staged dylibs`).toBeGreaterThan(0)
      expect(filesNamed(packagedDir, '.dylib')).toEqual(stagedDylibs)
      for (const name of stagedDylibs) {
        const packaged = fs.lstatSync(path.join(packagedDir, name))
        expect(packaged.isFile(), `${helper}/${name}`).toBe(true)
        expect(packaged.isSymbolicLink(), `${helper}/${name}`).toBe(false)
        expect(packaged.size, `${helper}/${name}`).toBeGreaterThan(200)
      }
    }
  })

  it.skipIf(process.platform !== 'darwin')('packages the native ExecuTorch speech runtime', () => {
    const runtime = path.join(resourcesDir, 'bin', 'executorch-speech')
    const stat = fs.statSync(runtime)
    expect(stat.isFile()).toBe(true)
    expect(stat.size).toBeGreaterThan(1_000_000)
    expect(fs.readFileSync(runtime).subarray(0, 4).toString('hex')).toBe('cffaedfe')
  })
})
