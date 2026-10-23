import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from './runtime-env'

export const EMBEDDING_MODELS = [
  {
    id: 'Xenova/all-MiniLM-L6-v2',
    name: 'MiniLM L6',
    detail: 'Fast · English · 384 dimensions',
    badge: 'Default',
    files: [650, 711661, 366, 90387606]
  },
  {
    id: 'Xenova/bge-small-en-v1.5',
    name: 'BGE Small',
    detail: 'Search quality · English · 384 dimensions',
    badge: 'Recommended',
    files: [683, 711396, 366, 133093490]
  },
  {
    id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    name: 'Multilingual MiniLM',
    detail: 'Many languages · 384 dimensions',
    badge: 'Multilingual',
    files: [673, 17082913, 496, 470268510]
  },
  {
    id: 'Xenova/bge-base-en-v1.5',
    name: 'BGE Base',
    detail: 'Larger search model · English · 768 dimensions',
    badge: 'More capable',
    files: [717, 711396, 366, 435811539]
  },
  {
    id: 'Xenova/all-MiniLM-L12-v2',
    name: 'MiniLM L12',
    detail: 'More layers · English · 384 dimensions',
    badge: 'Alternative',
    files: [610, 711661, 366, 133093467]
  }
] as const

export const EMBEDDING_CACHE_FILES = [
  'config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx'
] as const

export type EmbeddingModelId = string
export const DEFAULT_EMBEDDING_MODEL: EmbeddingModelId = EMBEDDING_MODELS[0].id

const choiceFile = (): string => path.join(dataDir(), 'embedding-model.json')

export function isEmbeddingModelId(value: unknown): value is EmbeddingModelId {
  return typeof value === 'string' && /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(value)
}

interface SavedEmbeddingModel {
  id: string
  dimensions: number
}

function readChoice(): SavedEmbeddingModel | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(choiceFile(), 'utf8'))
    if (isEmbeddingModelId(value)) return { id: value, dimensions: 384 }
    if (value && typeof value === 'object') {
      const choice = value as Partial<SavedEmbeddingModel>
      if (
        isEmbeddingModelId(choice.id) &&
        Number.isInteger(choice.dimensions) &&
        choice.dimensions! > 0 &&
        choice.dimensions! <= 4096
      ) {
        return { id: choice.id, dimensions: choice.dimensions! }
      }
    }
  } catch {
    /* use default */
  }
  return null
}

export function getEmbeddingModelId(): EmbeddingModelId {
  return readChoice()?.id ?? DEFAULT_EMBEDDING_MODEL
}

export function getEmbeddingDimensions(): number {
  return readChoice()?.dimensions ?? 384
}

export function saveEmbeddingModelId(id: EmbeddingModelId, dimensions = 384): void {
  if (
    !isEmbeddingModelId(id) ||
    !Number.isInteger(dimensions) ||
    dimensions < 1 ||
    dimensions > 4096
  ) {
    throw new Error('Invalid embedding model choice.')
  }
  fs.writeFileSync(choiceFile(), JSON.stringify({ id, dimensions }), { mode: 0o600 })
}
