import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import pruneOnnxRuntime, {
  packagedResourcesDir,
  targetOnnxRuntime
} from '../../../scripts/prune-onnx-runtime.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function context(root: string) {
  return {
    appOutDir: root,
    electronPlatformName: 'linux',
    arch: 1,
    packager: { appInfo: { productFilename: 'Off Grid AI Desktop' } }
  }
}

describe('packaged ONNX Runtime pruning', () => {
  it('maps electron-builder targets to the ONNX directory names', () => {
    expect(targetOnnxRuntime({ electronPlatformName: 'darwin', arch: 3 })).toEqual({
      platform: 'darwin',
      arch: 'arm64'
    })
    expect(targetOnnxRuntime({ electronPlatformName: 'win32', arch: 1 })).toEqual({
      platform: 'win32',
      arch: 'x64'
    })
  })

  it('resolves the macOS app resources directory', () => {
    expect(
      packagedResourcesDir({
        appOutDir: '/build/mac-arm64',
        electronPlatformName: 'darwin',
        packager: { appInfo: { productFilename: 'Off Grid AI Desktop' } }
      })
    ).toBe('/build/mac-arm64/Off Grid AI Desktop.app/Contents/Resources')
  })

  it('keeps only the packaged platform and architecture', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-onnx-package-'))
    roots.push(root)
    const runtimeRoot = path.join(
      root,
      'resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6'
    )
    for (const target of ['linux/x64', 'linux/arm64', 'darwin/arm64', 'win32/x64']) {
      const directory = path.join(runtimeRoot, target)
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, 'runtime.bin'), target)
    }

    await pruneOnnxRuntime(context(root))

    expect(fs.existsSync(path.join(runtimeRoot, 'linux/x64/runtime.bin'))).toBe(true)
    expect(fs.existsSync(path.join(runtimeRoot, 'linux/arm64'))).toBe(false)
    expect(fs.existsSync(path.join(runtimeRoot, 'darwin'))).toBe(false)
    expect(fs.existsSync(path.join(runtimeRoot, 'win32'))).toBe(false)
  })
})
