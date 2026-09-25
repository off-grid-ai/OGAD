import { randomUUID } from 'node:crypto'

const PREVIEW_SCHEME = 'ogartifact:'
const PREVIEW_HOST = 'preview'
export const MAX_ARTIFACT_PREVIEW_BYTES = 8 * 1024 * 1024
export const MAX_ARTIFACT_PREVIEWS_PER_OWNER = 8

export const ARTIFACT_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob: https://esm.sh",
  "style-src 'unsafe-inline'",
  'img-src data: blob: ogcapture:',
  'font-src data:',
  'connect-src https://esm.sh'
].join('; ')

interface ArtifactPreviewDocument {
  documentHtml: string
  ownerId: number
}

const documents = new Map<string, ArtifactPreviewDocument>()

function previewId(url: string): string | null {
  try {
    const parsed = new URL(url)
    const id = parsed.pathname.slice(1)
    if (
      parsed.protocol !== PREVIEW_SCHEME ||
      parsed.hostname !== PREVIEW_HOST ||
      !id ||
      id.includes('/')
    ) {
      return null
    }
    return id
  } catch {
    return null
  }
}

export function createArtifactPreview(documentHtml: string, ownerId: number): string {
  if (Buffer.byteLength(documentHtml, 'utf8') > MAX_ARTIFACT_PREVIEW_BYTES) {
    throw new RangeError('Artifact preview exceeds the 8 MiB limit')
  }
  const ownerDocumentCount = [...documents.values()].filter(
    (document) => document.ownerId === ownerId
  ).length
  if (ownerDocumentCount >= MAX_ARTIFACT_PREVIEWS_PER_OWNER) {
    throw new RangeError('Artifact preview limit reached')
  }

  const id = randomUUID()
  documents.set(id, { documentHtml, ownerId })
  return `${PREVIEW_SCHEME}//${PREVIEW_HOST}/${id}`
}

export function revokeArtifactPreview(url: string, ownerId: number): boolean {
  const id = previewId(url)
  const document = id ? documents.get(id) : undefined
  if (!id || document?.ownerId !== ownerId) {
    return false
  }
  return documents.delete(id)
}

export function revokeArtifactPreviewsForOwner(ownerId: number): number {
  let revoked = 0
  for (const [id, document] of documents) {
    if (document.ownerId === ownerId && documents.delete(id)) {
      revoked += 1
    }
  }
  return revoked
}

export function serveArtifactPreview(url: string): Response {
  const id = previewId(url)
  const document = id ? documents.get(id) : undefined
  if (!document) {
    return new Response(null, { status: 404 })
  }

  return new Response(document.documentHtml, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': ARTIFACT_CONTENT_SECURITY_POLICY,
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    }
  })
}
