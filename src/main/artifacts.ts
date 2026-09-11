// Canvas / artifacts runtime — serves the bundled, offline sandbox libraries
// (React UMD, Babel-standalone, Mermaid) to the renderer so model-generated
// HTML / React / SVG / Mermaid artifacts render in a sandboxed iframe with no
// network access. Libs live in resources/artifacts (no CDN).

import { app } from 'electron'
import { artifactTitle } from '@offgrid/artifacts'
import path from 'path'
import fs from 'fs'
import { createHash, randomUUID } from 'crypto'
import type { ArtifactKindContract } from '../shared/ipc-contracts'
import {
  withCanonicalConversationWrite,
  type CanonicalConversationWriteReceipt
} from './workspace-content/conversation-write-fence'

function artifactsDir(): string {
  const roots = app.isPackaged
    ? [path.join(process.resourcesPath, 'artifacts')]
    : [
        path.join(app.getAppPath(), 'resources', 'artifacts'),
        path.join(process.cwd(), 'resources', 'artifacts')
      ]
  for (const r of roots) {
    if (fs.existsSync(r)) return r
  }
  return roots[0]!
}

function read(name: string): string {
  try {
    return fs.readFileSync(path.join(artifactsDir(), name), 'utf8')
  } catch {
    return ''
  }
}

// 'text' and 'image' are uploaded INPUTS (files / pasted blocks / images the user
// attached), catalogued alongside model-generated artifacts so a chat's/project's
// whole working set — inputs and outputs — lives in one place. For 'text' the code
// is the document body; for 'image' it's the on-disk path. Neither is sandboxed.
export type ArtifactKind = ArtifactKindContract

/** Return only the runtime libs an artifact kind needs (kept off the wire otherwise). */
export function artifactRuntime(kind: ArtifactKind): Record<string, string> {
  if (kind === 'mermaid') return { mermaid: read('mermaid.min.js') }
  if (kind === 'react') {
    return {
      react: read('react.min.js'),
      reactDom: read('react-dom.min.js'),
      babel: read('babel.min.js')
    }
  }
  return {} // html / svg / text need no libs
}

// ─── Artifact library (persisted on-device, browsable in the gallery) ─────────
// Model-generated artifacts are saved to userData/artifacts-library as small JSON
// records so they can be revisited, re-rendered, downloaded, or deleted later —
// the same way generated images persist under userData/generated-images.

export interface SavedArtifact {
  id: string
  kind: ArtifactKind
  code: string
  title: string
  created: number
  conversationId?: string
  projectId?: string | null
}

function libraryDir(): string {
  const d = path.join(app.getPath('userData'), 'artifacts-library')
  fs.mkdirSync(d, { recursive: true })
  return d
}

/** Persist an artifact (deduped by content + chat). Returns the saved record. */
export function saveArtifact(a: {
  kind: ArtifactKind
  code: string
  title?: string
  conversationId?: string
  projectId?: string | null
}): SavedArtifact {
  return a.conversationId
    ? withCanonicalConversationWrite(a.conversationId, () => saveArtifactFile(a))
    : saveArtifactFile(a).value
}

function saveArtifactFile(a: {
  kind: ArtifactKind
  code: string
  title?: string
  conversationId?: string
  projectId?: string | null
}): CanonicalConversationWriteReceipt<SavedArtifact> {
  // Scope into the id so the same code in different chats are distinct records.
  const id = createHash('sha1')
    .update(`${a.kind}\n${a.conversationId || ''}\n${a.code}`)
    .digest('hex')
    .slice(0, 16)
  const file = path.join(libraryDir(), `${id}.json`)
  let preexistingBytes: Buffer | undefined
  if (fs.existsSync(file)) {
    try {
      preexistingBytes = fs.readFileSync(file)
      return { value: JSON.parse(preexistingBytes.toString('utf8')) as SavedArtifact }
    } catch {
      // Keep the exact preimage so a failed database commit can restore it.
    }
  }
  const rec: SavedArtifact = {
    id,
    kind: a.kind,
    code: a.code,
    title: (a.title || artifactTitle({ kind: a.kind, code: a.code })).trim(),
    created: Date.now(),
    conversationId: a.conversationId,
    projectId: a.projectId ?? null
  }
  // Write beside the destination and promote only after the complete record is on
  // disk. A full volume can otherwise leave truncated JSON at the final path and
  // make the existing artifact library unreadable.
  const encoded = Buffer.from(JSON.stringify(rec))
  const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporaryFile, encoded)
    fs.renameSync(temporaryFile, file)
  } finally {
    fs.rmSync(temporaryFile, { force: true })
  }
  return {
    value: rec,
    compensate: () => {
      let current: Buffer
      try {
        current = fs.readFileSync(file)
      } catch {
        return
      }
      // Never remove or replace bytes written by a later owner.
      if (!current.equals(encoded)) return
      if (preexistingBytes === undefined) {
        fs.rmSync(file, { force: true })
        return
      }
      const restoreFile = `${file}.${process.pid}.${randomUUID()}.rollback`
      try {
        fs.writeFileSync(restoreFile, preexistingBytes)
        fs.renameSync(restoreFile, file)
      } finally {
        fs.rmSync(restoreFile, { force: true })
      }
    }
  }
}

/** Saved artifacts, newest first. Optionally scoped to a chat or a project. */
export function listArtifacts(scope?: {
  conversationId?: string
  projectId?: string | null
}): SavedArtifact[] {
  try {
    let all = fs
      .readdirSync(libraryDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(libraryDir(), f), 'utf8')) as SavedArtifact)
      .sort((a, b) => b.created - a.created)
    if (scope?.conversationId) all = all.filter((r) => r.conversationId === scope.conversationId)
    else if (scope?.projectId) all = all.filter((r) => r.projectId === scope.projectId)
    return all
  } catch {
    return []
  }
}

/** Delete a saved artifact by id. */
export function deleteArtifact(id: string): boolean {
  try {
    fs.unlinkSync(path.join(libraryDir(), `${path.basename(id)}.json`))
    return true
  } catch {
    return false
  }
}

/** Delete every artifact scoped to a project — called when the project is deleted
 *  so its generated images/docs don't orphan in the library. Returns the count. */
export function deleteArtifactsForProject(projectId: string): number {
  let n = 0
  for (const a of listArtifacts({ projectId })) {
    if (deleteArtifact(a.id)) n++
  }
  return n
}

/**
 * Idempotent, fail-closed cleanup for the Shared project-deletion workflow.
 *
 * Read and validate the full library before deleting a matching record. A damaged record can hide
 * its project owner, so recovery must stop instead of claiming that project cleanup completed.
 */
export function removeProjectArtifactsForRecovery(
  projectId: string,
  commitFence: () => boolean = () => true
): void | 'fenced' {
  let names: string[]
  try {
    names = fs.readdirSync(libraryDir()).filter((name) => name.endsWith('.json'))
  } catch (cause) {
    throw new Error('The artifact library could not be read for project deletion.', { cause })
  }

  const matches = names.flatMap((name) => {
    const file = path.join(libraryDir(), name)
    const entry = fs.lstatSync(file)
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('The artifact library contains an entry with unknown byte ownership.')
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    } catch (cause) {
      throw new Error('The artifact library contains an unreadable ownership record.', { cause })
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('The artifact library contains an invalid ownership record.')
    }
    const artifact = decoded as Partial<SavedArtifact>
    if (
      artifact.projectId !== undefined &&
      artifact.projectId !== null &&
      typeof artifact.projectId !== 'string'
    ) {
      throw new Error('The artifact library contains an invalid project owner.')
    }
    return artifact.projectId === projectId ? [file] : []
  })

  for (const file of matches) {
    if (!commitFence()) return 'fenced'
    fs.rmSync(file, { force: true })
  }
}

/** Delete every artifact scoped to a conversation — called when the conversation
 *  is deleted so its generated images/docs don't orphan in the library (D23). */
export function deleteArtifactsForConversation(conversationId: string): number {
  let n = 0
  for (const a of listArtifacts({ conversationId })) {
    if (deleteArtifact(a.id)) n++
  }
  return n
}
