// Where to find the bundled stable-diffusion.cpp binaries, in preference order.
//
// Windows ships TWO builds so image gen can use the GPU without breaking GPU-less
// boxes, mirroring the llama bin/llama + bin/llama-cpu ladder:
//   sd/      <- Vulkan (GPU) build, primary. Offloads to any Vulkan device.
//   sd-cpu/  <- CPU-only build, fallback (no Vulkan loader present).
// macOS/Linux ship only sd/ (the Metal build), so this is effectively single-entry
// there. Pure: returns candidate paths in preference order; the caller checks which
// exists (and, for the resident server, whether it actually becomes ready).
import path from 'path'
import { exe } from './runtime-env'

export const SD_RUNTIME_DIRS = ['sd', 'sd-cpu'] as const

/** Candidate absolute paths for a bundled sd binary (`sd-cli` / `sd-server`), GPU build
 *  first then CPU fallback, across every bin root. Pure. */
export function sdBinaryCandidates(binRoots: string[], binaryName: string): string[] {
  const name = exe(binaryName)
  const out: string[] = []
  for (const dir of SD_RUNTIME_DIRS) {
    for (const root of binRoots) {
      out.push(path.join(root, dir, name))
    }
  }
  return out
}
