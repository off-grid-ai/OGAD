export type ByteOwnerKind = 'local' | 'provenance'

export function byteOwnerKind(value: string, imageId: string): ByteOwnerKind {
  if (value === 'local' || value === 'provenance') return value
  throw new Error(`Generated-image release intent ${imageId} has unknown owner kind ${value}.`)
}
