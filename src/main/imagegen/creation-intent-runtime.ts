import type { GeneratedImageCreationIntentRepository } from './creation-intent-repository'

let activeRepository: GeneratedImageCreationIntentRepository | null = null

export function registerGeneratedImageCreationIntents(
  registeredRepository?: GeneratedImageCreationIntentRepository
): () => void {
  activeRepository = registeredRepository ?? null
  return () => {
    if (activeRepository === registeredRepository) activeRepository = null
  }
}

function repository(): GeneratedImageCreationIntentRepository {
  if (!activeRepository) throw new Error('Desktop generated-image repository is not initialized.')
  return activeRepository
}

export function prepareDesktopGeneratedImageOutputPath(
  requestId: string,
  extension: string
): string {
  const root = path.join(dataDir(), 'generated-images')
  fs.mkdirSync(root, { recursive: true })
  const destination = resolveOwnedDestination(root, `${requestId}${extension}`)
  if (!destination) throw new Error('The generated-image output identity is unsafe.')
  repository().prebindPath(requestId, 'output', destination)
  return destination
}

export function assertDesktopGeneratedImageOutputPrepared(outputPath: string): void {
  repository().assertPreparedOutput(outputPath)
}

export function prepareDesktopGeneratedImageCreation(
  requestId: string,
  expectsSource: boolean
): void {
  repository().prepare(requestId, expectsSource)
}

export function prebindDesktopGeneratedImageCreationPath(
  requestId: string,
  kind: 'output' | 'source',
  ownedPath: string
): void {
  repository().prebindPath(requestId, kind, ownedPath)
}

export function sealDesktopGeneratedImageCreationPath(
  requestId: string,
  kind: 'output' | 'source',
  ownedPath: string
): void {
  repository().sealPath(requestId, kind, ownedPath)
}

export function settleMissingDesktopGeneratedImageSource(requestId: string): void {
  repository().settleMissingSource(requestId)
}

export function settleDesktopGeneratedImageCreation(requestId: string): void {
  repository().recover(requestId)
}

export function settleDesktopGeneratedImageCreationIntentsForPrivacy(): void {
  repository().reconcilePending()
  repository().assertSettled()
}
import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from '../runtime-env'
import { resolveOwnedDestination } from './owned-path'
