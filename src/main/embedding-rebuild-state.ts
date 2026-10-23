let rebuilding = false

export function isEmbeddingIndexRebuilding(): boolean {
  return rebuilding
}
export function setEmbeddingIndexRebuilding(value: boolean): void {
  rebuilding = value
}
