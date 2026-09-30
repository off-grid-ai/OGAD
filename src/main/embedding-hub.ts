export interface EmbeddingHubModel {
  id: string
  name: string
  org: string
  downloads?: number
  likes?: number
}

interface HubModel {
  id?: string
  pipeline_tag?: string
  config?: { architectures?: string[] }
  downloads?: number
  likes?: number
  siblings?: Array<{ rfilename: string }>
}

type FetchLike = typeof fetch

export function isTextEmbeddingRepository(model: HubModel): boolean {
  if (model.pipeline_tag !== 'feature-extraction' || !model.id) return false
  if (/(?:rerank|cross[-_]?encoder)/i.test(model.id)) return false
  if (
    model.config?.architectures?.some((name) =>
      /(?:ForSequenceClassification|ForTokenClassification|ForQuestionAnswering|ForCausalLM|ForMaskedLM|Rerank)/i.test(
        name
      )
    )
  )
    return false
  const files = new Set((model.siblings ?? []).map((file) => file.rfilename))
  return (
    files.has('config.json') &&
    (files.has('tokenizer.json') || files.has('vocab.txt') || files.has('spiece.model')) &&
    [...files].some((file) => /^onnx\/model(?:_[a-z0-9]+)?\.onnx$/i.test(file))
  )
}

export async function searchEmbeddingModels(
  query: string,
  fetchImpl: FetchLike = fetch
): Promise<EmbeddingHubModel[]> {
  const trimmed = query.trim()
  if (trimmed.length < 2) return []
  const params = new URLSearchParams({
    pipeline_tag: 'feature-extraction',
    search: trimmed,
    sort: 'downloads',
    direction: '-1',
    limit: '100',
    full: 'true'
  })
  const response = await fetchImpl(`https://huggingface.co/api/models?${params}`)
  if (!response.ok) throw new Error(`Hugging Face search failed: HTTP ${response.status}`)
  const models = (await response.json()) as HubModel[]
  return models
    .filter(isTextEmbeddingRepository)
    .slice(0, 30)
    .map((model) => ({
      id: model.id!,
      name: model.id!.split('/').pop()!,
      org: model.id!.split('/')[0]!,
      downloads: model.downloads,
      likes: model.likes
    }))
}

export async function verifyEmbeddingModel(
  id: string,
  fetchImpl: FetchLike = fetch
): Promise<void> {
  if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(id)) throw new Error('Invalid model ID.')
  const response = await fetchImpl(`https://huggingface.co/api/models/${id}`)
  if (!response.ok) throw new Error(`Could not check this model: HTTP ${response.status}`)
  if (!isTextEmbeddingRepository((await response.json()) as HubModel)) {
    throw new Error('This model needs feature extraction, text tokenizer files, and ONNX weights.')
  }
}
