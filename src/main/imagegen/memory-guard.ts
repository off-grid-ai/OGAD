// Pure RAM footprint / guard math for image generation. On Apple Silicon unified
// memory an oversized model swaps to disk and FREEZES the machine, so we refuse
// rather than freeze. The I/O shell (imagegen.ts) reads os.totalmem() and the
// on-disk file sizes; this module only does the arithmetic + the decision.

export interface MemoryGuardInput {
  /** Total machine RAM in GB (os.totalmem() / 1e9). */
  totalGb: number
  /** Diffusion model file size in GB (0 for Core ML — runs on the ANE, exempt). */
  modelSizeGb: number
  /** Whether this pick runs on Core ML (ANE) — exempt from the guard. */
  coreml: boolean
  /** Whether this is the Z-Image 3-model stack. */
  zImageStack: boolean
  /** Whether this is the Qwen-Image 2.1 multi-file stack. */
  qwenImageStack?: boolean
  /** Z-Image Qwen3-4B text-encoder size in GB (0 when not a Z-Image stack). */
  zEncoderGb?: number
  /** Z-Image FLUX VAE size in GB (0 when not a Z-Image stack). */
  zVaeGb?: number
  /** Qwen-Image 2.1 companion file sizes. */
  qwenEncoderGb?: number
  qwenVisionGb?: number
  qwenVaeGb?: number
}

export interface MemoryGuardResult {
  /** Estimated resident footprint in GB. */
  modelGb: number
  /** Available budget in GB after the RAM-scaled reserve. */
  budgetGb: number
  /** RAM reserved for the OS + everything else. */
  reserveGb: number
  /** True when the model would exceed the budget (refuse to run). */
  overBudget: boolean
}

/** Reserve scales with RAM so an 8GB machine isn't blocked outright — a flat 7GB
 *  reserve would leave it ~1GB and reject everything. */
export function reserveForRam(totalGb: number): number {
  return totalGb <= 10 ? 4 : 6
}

/** Compute the resident footprint + over-budget decision. Core ML is exempt
 *  (modelGb 0). For a Z-Image stack the diffusion file alone understates the
 *  footprint (encoder + VAE are all resident at once), so they're counted too;
 *  the whole stack is scaled by 1.4 to cover runtime overhead. */
export function evaluateMemoryGuard(input: MemoryGuardInput): MemoryGuardResult {
  const { totalGb, modelSizeGb, coreml, zImageStack, qwenImageStack = false } = input
  const reserveGb = reserveForRam(totalGb)
  const zEncoderGb = zImageStack ? (input.zEncoderGb ?? 0) : 0
  const zVaeGb = zImageStack ? (input.zVaeGb ?? 0) : 0
  const qwenEncoderGb = qwenImageStack ? (input.qwenEncoderGb ?? 0) : 0
  const qwenVisionGb = qwenImageStack ? (input.qwenVisionGb ?? 0) : 0
  const qwenVaeGb = qwenImageStack ? (input.qwenVaeGb ?? 0) : 0
  const modelGb = coreml
    ? 0
    : (modelSizeGb + zEncoderGb + zVaeGb + qwenEncoderGb + qwenVisionGb + qwenVaeGb) * 1.4
  const budgetGb = totalGb - reserveGb
  return { modelGb, budgetGb, reserveGb, overBudget: modelGb > budgetGb }
}
