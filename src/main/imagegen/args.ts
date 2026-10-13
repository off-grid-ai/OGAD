// Pure argv construction for each image-gen runtime. The sd.cpp builders (Z-Image, Qwen-Image,
// standard checkpoints) live in @offgrid/models so Desktop and Mobile use one set of rules; the
// Core ML helper below is Desktop-only. No fs / spawn / electron: the I/O shell (imagegen.ts)
// resolves paths and passes them in.

export {
  DEFAULT_IMAGE_NEGATIVE as DEFAULT_NEGATIVE,
  buildQwenImage21Args,
  buildStandardArgs,
  buildZImageArgs,
  qwenImageArgsForBackend,
  type QwenImage21ArgsInput,
  type StandardArgsInput,
  type ZImageArgsInput
} from '@offgrid/models'

export interface CoreMLArgsInput {
  model: string
  prompt: string
  outPath: string
  steps?: number
  seed: number
  negativePrompt?: string
}

/** Core ML (ANE) helper — directory model, prompt to PNG. No preview file. */
export function buildCoreMLArgs(i: CoreMLArgsInput): string[] {
  const args = [
    '--model',
    i.model,
    '--prompt',
    i.prompt,
    '--output',
    i.outPath,
    '--steps',
    String(i.steps ?? 16),
    '--seed',
    String(i.seed)
  ]
  const neg = i.negativePrompt?.trim()
  if (neg) args.push('--negative', neg)
  return args
}
