// Video memory saving. stable-diffusion.cpp can keep idle weights in RAM (--offload-to-cpu) and
// decode in tiles (--vae-tiling). Both save GPU memory and both make a clip slower.
// 'save' (the default) always uses them. 'fit' (set by Fastest settings) lets an NVIDIA GPU with
// clearly enough free memory run a clip without them; the video engine then retries with them on
// the same GPU if that run fails. Only nvidia-smi reports free memory, so other GPUs always save.

import { getSetting, saveSetting } from './database'
import { cudaVramMB } from './llm/vram-probe'

export type VideoMemoryMode = 'save' | 'fit'

const KEY = 'runtime:video-memory'
/** Free memory must be this many times the clip's estimate before the savings are skipped. */
const FREE_MEMORY_MARGIN = 1.5

export function getVideoMemoryMode(): VideoMemoryMode {
  return getSetting<unknown>(KEY, 'save') === 'fit' ? 'fit' : 'save'
}

export function setVideoMemoryMode(mode: VideoMemoryMode): void {
  saveSetting(KEY, mode)
}

/** True when a clip of `neededMB` can run on this engine rung without the memory savings. */
export function videoFitsGpu(backend: string, cpuOnly: boolean, neededMB: number): boolean {
  if (cpuOnly || backend !== 'cuda' || neededMB <= 0 || getVideoMemoryMode() !== 'fit') return false
  const vram = cudaVramMB()
  return vram !== null && vram.freeMB >= neededMB * FREE_MEMORY_MARGIN
}
