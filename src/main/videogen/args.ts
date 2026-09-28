import type { VideoGenerationRequestContract } from '../../shared/video-generation-contract'

export interface VideoModelPack {
  weight: string
  vae: string
  encoder: string
}

export function videoArgs(
  pack: VideoModelPack,
  request: Required<Omit<VideoGenerationRequestContract, 'model' | 'enhancePrompt'>>,
  output: string
): string[] {
  return [
    '-M', 'vid_gen',
    '--diffusion-model', pack.weight,
    '--vae', pack.vae,
    '--t5xxl', pack.encoder,
    '-p', request.prompt,
    '-n', request.negativePrompt,
    '-W', String(request.width),
    '-H', String(request.height),
    '--video-frames', String(request.frames),
    '--fps', String(request.fps),
    '--steps', String(request.steps),
    '--cfg-scale', String(request.guidance),
    '--sampling-method', 'euler',
    '--flow-shift', '3',
    '--diffusion-fa',
    '--vae-tiling',
    '-s', String(request.seed),
    '-o', output
  ]
}
