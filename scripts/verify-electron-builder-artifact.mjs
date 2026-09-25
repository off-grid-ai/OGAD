/* eslint-disable @typescript-eslint/explicit-function-return-type -- Electron-builder loads this hook directly as JavaScript. */
import fs from 'node:fs'
import path from 'node:path'
import {
  assertAsarArchiveInventory,
  verifyDmgArtifact,
  verifyReleaseDmgArtifact,
  verifyReleaseZipArtifact,
  verifyZipArtifact
} from './lib/macos-artifact-integrity.mjs'
import { releaseTeamIdForEnvironment } from './lib/macos-app-trust.mjs'

export default async function verifyElectronBuilderArtifact(event) {
  const artifact = event.file.toLowerCase()
  const asarOnlyArtifact =
    artifact.endsWith('.exe') || artifact.endsWith('.appimage') || artifact.endsWith('.deb')
  if (!artifact.endsWith('.dmg') && !artifact.endsWith('.zip') && !asarOnlyArtifact) {
    return
  }

  const appOutDir = event.packager.computeAppOutDir(event.target.outDir, event.arch)
  if (asarOnlyArtifact) {
    assertAsarArchiveInventory(path.join(appOutDir, 'resources', 'app.asar'))
    const executable = artifact.endsWith('.exe') ? 'llama-server.exe' : 'llama-server'
    const required = [
      ...[
        'llama-cuda',
        'llama',
        'llama-cpu',
        'llama-prism-cuda',
        'llama-prism',
        'llama-prism-cpu'
      ].map((variant) => path.join('bin', variant, executable)),
      ...(artifact.endsWith('.exe')
        ? ['cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll']
        : ['libcudart.so.12', 'libcublas.so.12', 'libcublasLt.so.12']
      ).map((library) => path.join('bin', 'cuda-runtime', library))
    ]
    if (artifact.endsWith('.appimage') || artifact.endsWith('.deb')) {
      required.push(
        path.join('bin', 'whisper', 'whisper-cli'),
        path.join('bin', 'whisper', 'LICENSE'),
        path.join('bin', 'ffmpeg'),
        path.join('bin', 'licenses', 'ffmpeg.txt'),
        path.join('bin', 'sd', 'sd-cli'),
        path.join('bin', 'sd', 'sd-server'),
        path.join('bin', 'sd', 'libggml-vulkan.so'),
        path.join('bin', 'sd', 'libgomp.so.1'),
        path.join('bin', 'sd', 'libvulkan.so.1'),
        path.join('bin', 'licenses', 'libgomp1.txt'),
        path.join('bin', 'licenses', 'libvulkan1.txt'),
        path.join('bin', 'executorch-speech'),
        path.join('speech-assets', 'index.json')
      )
    }
    for (const relative of required) {
      const file = path.join(appOutDir, 'resources', relative)
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new Error(`installer input is missing required runtime: ${relative}`)
      }
    }
    if (artifact.endsWith('.appimage') || artifact.endsWith('.deb')) {
      const libvips = path.join(
        appOutDir,
        'resources',
        'app.asar.unpacked',
        'node_modules',
        '@img',
        'sharp-libvips-linux-x64',
        'lib',
        'libvips-cpp.so.8.18.3'
      )
      if (!fs.existsSync(libvips) || !fs.statSync(libvips).isFile()) {
        throw new Error('installer input is missing the unpacked Sharp libvips library')
      }
    }
    console.log('[artifact-integrity] installer input passed ASAR and native-runtime inventory')
    return
  }

  const referenceBundle = path.join(appOutDir, `${event.packager.appInfo.productFilename}.app`)
  const releaseTeamId = releaseTeamIdForEnvironment(process.env)

  console.log(`[artifact-integrity] verifying ${path.basename(event.file)} before publication`)
  if (artifact.endsWith('.dmg')) {
    if (releaseTeamId) {
      await verifyReleaseDmgArtifact(event.file, referenceBundle, releaseTeamId)
      console.log('[artifact-integrity] DMG contains the Developer ID signed, notarized app')
    } else {
      await verifyDmgArtifact(event.file, referenceBundle)
      console.log('[artifact-integrity] DMG bundle matches the locally signed packaged app')
    }
    return
  }

  if (releaseTeamId) {
    await verifyReleaseZipArtifact(event.file, referenceBundle, releaseTeamId)
    console.log('[artifact-integrity] updater ZIP contains the Developer ID signed, notarized app')
  } else {
    await verifyZipArtifact(event.file, referenceBundle)
    console.log('[artifact-integrity] updater ZIP matches the locally signed packaged app')
  }
}
