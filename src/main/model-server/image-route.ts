// Pure shaping for the gateway's image routes. No I/O, no Electron - extracted
// from model-server.ts so the response shape (incl. sync_id), the busy mapping,
// and the poll progress enrichment are defined once and unit-testable.
import type { ImageGenerationJobContract } from '../../shared/image-generation-contract'

export interface GatewayImageOutput {
  dataUrl: string
  path: string
  prompt: string
  seed?: number
  model?: string
  /** The image's mesh identity, present when the job service produced it. */
  syncId?: string
}

/** OpenAI-shaped image response. `sync_id` names the same image on the device
 *  mesh, so a paired phone can dedupe the synced copy against this response. */
export function shapeImageResponse(
  out: GatewayImageOutput,
  responseFormat: string
): Record<string, unknown> {
  const base = {
    revised_prompt: out.prompt,
    seed: out.seed,
    model: out.model,
    ...(out.syncId ? { sync_id: out.syncId } : {})
  }
  const datum =
    responseFormat === 'url'
      ? { url: `file://${out.path}`, ...base }
      : { b64_json: out.dataUrl.slice(out.dataUrl.indexOf(',') + 1), ...base }
  return {
    created: Math.floor(Date.now() / 1000),
    data: [datum],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }
}

/** Live progress for a pending image poll. Only meaningful while THIS request is
 *  the running job - the single-job lock guarantees that: a request that reached
 *  'running' holds the job service, so its snapshot is ours to report. */
export function pollProgress(
  kind: string,
  status: string,
  job: Pick<ImageGenerationJobContract, 'phase' | 'stage' | 'progress'>
): Record<string, unknown> | null {
  if (kind !== 'image' || status !== 'running' || job.phase !== 'running') return null
  return {
    stage: job.stage,
    ...(job.progress ? { step: job.progress.step, total: job.progress.total } : {})
  }
}
