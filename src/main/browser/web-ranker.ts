import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer
} from '@huggingface/transformers'
import { dataDir, modelsDir } from '../runtime-env'

/**
 * The web page ranker: a MiniLM-L6 cross-encoder fine-tuned on the action data
 * (scripts/action-data/train/ranker.py), as ONNX. It scores each AX line for the current plan step;
 * @offgrid/use rankedPageView keeps the best lines. The files live in the app's own data folder
 * (local: a synced models folder, such as iCloud Drive, can offload a file the app reads on every
 * action), or else in the models folder:
 *   <data or models>/offgrid-web-ranker/{config.json, tokenizer.json, tokenizer_config.json, onnx/model.onnx}
 * Runs on the CPU: on macOS, CoreML ran MiniLM about 9x slower (embeddings-core.ts, measured).
 */
export const WEB_RANKER_ID = 'offgrid-web-ranker'
/** Pairs per model call: the page's candidate lines go in a few calls, not one per line. */
const BATCH = 64

let loading: Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> | null = null

/** The folder that holds the ranker: the data folder first, then the models folder. */
function rankerRoot(): string | null {
  for (const root of [dataDir(), modelsDir()]) {
    if (existsSync(join(root, WEB_RANKER_ID, 'onnx', 'model.onnx'))) return root
  }
  return null
}

export function webRankerInstalled(): boolean {
  return rankerRoot() !== null
}

function load(): Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> {
  if (!loading) {
    // localModelPath is shared with the embeddings: point it at the ranker only while it loads.
    const previous = env.localModelPath
    env.localModelPath = rankerRoot() ?? modelsDir()
    const options = { local_files_only: true }
    loading = Promise.all([
      AutoTokenizer.from_pretrained(WEB_RANKER_ID, options),
      AutoModelForSequenceClassification.from_pretrained(WEB_RANKER_ID, {
        ...options,
        device: 'cpu',
        dtype: 'fp32'
      })
    ])
      .then(([tokenizer, model]) => ({ tokenizer, model }))
      .finally(() => {
        env.localModelPath = previous
      })
    loading.catch(() => {
      loading = null
    })
  }
  return loading
}

/** The ranker's score for each line (higher is more relevant to the query), same order. */
export async function scoreWebLines(query: string, units: readonly string[]): Promise<number[]> {
  if (!units.length) return []
  const { tokenizer, model } = await load()
  const scores: number[] = []
  for (let i = 0; i < units.length; i += BATCH) {
    const group = units.slice(i, i + BATCH)
    const inputs = tokenizer(new Array(group.length).fill(query), {
      text_pair: [...group],
      padding: true,
      truncation: true,
      max_length: 128
    })
    const { logits } = await model(inputs)
    scores.push(...(logits.tolist() as number[][]).map((row) => row[0] ?? -1e9))
  }
  return scores
}
