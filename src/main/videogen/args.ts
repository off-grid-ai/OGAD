import type { VideoGenerationRequestContract } from '../../shared/video-generation-contract'

import { videoArchitecture, type VideoModelPack } from '@offgrid/models'
export type { VideoModelPack } from '@offgrid/models'

export function videoArgs(
  pack: VideoModelPack,
  request: Required<Omit<VideoGenerationRequestContract, 'model' | 'enhancePrompt'>>,
  output: string
): string[] {
  return [
    '-M',
    'vid_gen',
    '--diffusion-model',
    pack.weight,
    '--vae',
    pack.vae,
    ...(pack.encoder ? ['--t5xxl', pack.encoder] : []),
    ...(pack.llm ? ['--llm', pack.llm] : []),
    ...(pack.embeddings ? ['--embeddings-connectors', pack.embeddings] : []),
    ...(pack.audioVae ? ['--audio-vae', pack.audioVae] : []),
    '-p',
    request.prompt,
    '-n',
    request.negativePrompt,
    '-W',
    String(request.width),
    '-H',
    String(request.height),
    '--video-frames',
    String(request.frames),
    '--fps',
    String(request.fps),
    '--steps',
    String(request.steps),
    '--cfg-scale',
    String(request.guidance),
    '--sampling-method',
    'euler',
    ...(videoArchitecture(pack.weight)?.startsWith('wan') ? ['--flow-shift', '3'] : []),
    '--offload-to-cpu',
    '--diffusion-fa',
    '--vae-tiling',
    // Wan 2.2's 3D VAE decode is much slower on Metal. Keep diffusion on
    // Metal and use the CPU decoder that completed the live macOS check.
    ...(process.platform === 'darwin' && pack.vae.endsWith('wan2.2_vae.safetensors')
      ? ['--backend', 'vae=cpu']
      : []),
    '-s',
    String(request.seed),
    '-o',
    output
  ]
}
