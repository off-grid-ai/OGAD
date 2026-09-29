/** CUDA model and CLIP loads can exceed one minute on a cold device. */
export function modelStartupTimeout(engineName: string): number {
  return engineName.endsWith('-cuda') ? 180_000 : 60_000
}
