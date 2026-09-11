import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { textContextLength, type LlamaKvCacheType, type PerformanceMode } from '@offgrid/models'

function weightsSizeGb(file: string): number {
  try {
    return fs.statSync(file).size / 1e9
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(
        `[LLMService] could not measure ${path.basename(file)} for the context budget; treating it as 0 GB`,
        error
      )
    }
    return 0
  }
}

export function safeTextContextSize(input: {
  requested: number
  trainedContext: number | null
  modelPath: string
  projectorPath: string
  kvType: LlamaKvCacheType
  performanceMode: PerformanceMode
}): number {
  let totalGb: number | undefined
  let weightsGb: number | undefined
  try {
    totalGb = os.totalmem() / 1e9
    weightsGb = weightsSizeGb(input.modelPath)
    if (input.projectorPath) weightsGb += weightsSizeGb(input.projectorPath)
  } catch {
    totalGb = undefined
    weightsGb = undefined
  }
  const effective = textContextLength({
    requested: input.requested,
    trainedContext: input.trainedContext,
    totalGb,
    weightsGb,
    kvType: input.kvType,
    performanceMode: input.performanceMode
  })
  if (typeof totalGb === 'number' && typeof weightsGb === 'number' && effective < input.requested) {
    console.warn(
      `[LLMService] Clamping context ${input.requested} -> ${effective} (RAM ${totalGb.toFixed(0)}GB, weights ${weightsGb.toFixed(1)}GB) to avoid memory overcommit`
    )
  }
  return effective
}
