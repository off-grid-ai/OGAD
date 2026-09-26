import fs from 'node:fs'
import path from 'node:path'

const ARCH_NAMES = new Map([
  [0, 'ia32'],
  [1, 'x64'],
  [2, 'armv7l'],
  [3, 'arm64'],
  [4, 'universal']
])

export function packagedResourcesDir(context) {
  if (context.electronPlatformName !== 'darwin') {
    return path.join(context.appOutDir, 'resources')
  }
  return path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources'
  )
}

export function targetOnnxRuntime(context) {
  const platform = context.electronPlatformName
  const arch = ARCH_NAMES.get(context.arch)
  if (!arch) throw new Error(`Unsupported ONNX Runtime package architecture: ${String(context.arch)}`)
  return { platform, arch }
}

export default async function pruneOnnxRuntime(context) {
  const runtimeRoot = path.join(
    packagedResourcesDir(context),
    'app.asar.unpacked',
    'node_modules',
    'onnxruntime-node',
    'bin',
    'napi-v6'
  )
  if (!fs.existsSync(runtimeRoot)) {
    throw new Error(`Packaged ONNX Runtime directory is missing: ${runtimeRoot}`)
  }

  const target = targetOnnxRuntime(context)
  for (const platform of fs.readdirSync(runtimeRoot)) {
    const platformDir = path.join(runtimeRoot, platform)
    if (platform !== target.platform) {
      fs.rmSync(platformDir, { recursive: true, force: true })
      continue
    }
    for (const arch of fs.readdirSync(platformDir)) {
      if (arch !== target.arch) {
        fs.rmSync(path.join(platformDir, arch), { recursive: true, force: true })
      }
    }
  }

  const targetDir = path.join(runtimeRoot, target.platform, target.arch)
  if (!fs.existsSync(targetDir) || fs.readdirSync(targetDir).length === 0) {
    throw new Error(`Packaged ONNX Runtime files are missing for ${target.platform}/${target.arch}`)
  }
  console.log(`[onnx-runtime] kept ${target.platform}/${target.arch}; removed other targets`)
}
