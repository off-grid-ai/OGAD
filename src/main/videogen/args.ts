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
    // Wan 2.2's 3D VAE decode is much slower on Metal. Keep diffusion on
    // Metal and use the CPU decoder that completed the live macOS check.
    ...(process.platform === 'darwin' && pack.vae.endsWith('wan2.2_vae.safetensors')
      ? ['--backend', 'vae=cpu']
      : []),
    '-s', String(request.seed),
    '-o', output
  ]
}
