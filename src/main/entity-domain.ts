import {
  assessEntityCandidate,
  type EntityAdmissionContext,
  type EntityAdmissionRejection,
  type EntityCandidate
} from '@offgrid/memory'
import { deleteEntityRecord, resolveEntityRecord } from './database'

export type EntityResolution =
  | {
      admitted: true
      entityId: number
      created: boolean
      candidate: EntityCandidate
    }
  | { admitted: false; reason: EntityAdmissionRejection }

/** Foundational entity operations that core callers are allowed to depend on. */
export interface EntityDomain {
  resolve(candidate: EntityCandidate, context?: EntityAdmissionContext): EntityResolution
  delete(entityId: number): boolean
}

const sqliteEntityDomain: EntityDomain = {
  resolve(candidate) {
    const persisted = resolveEntityRecord(candidate.name, candidate.type ?? 'Unknown')
    return { admitted: true, ...persisted, candidate }
  },
  delete(entityId) {
    return deleteEntityRecord(entityId)
  }
}

let registeredEntityDomain: EntityDomain | null = null

/**
 * Register a richer entity implementation (for example Pro alias resolution).
 * The returned disposer only removes the implementation it registered, so a
 * stale shutdown cannot accidentally clear a newer registration.
 */
export function registerEntityDomain(domain: EntityDomain): () => void {
  const previous = registeredEntityDomain
  registeredEntityDomain = domain
  return () => {
    if (registeredEntityDomain === domain) registeredEntityDomain = previous
  }
}

function getEntityDomain(): EntityDomain {
  return registeredEntityDomain ?? sqliteEntityDomain
}

export function resolveEntityCandidate(
  candidate: EntityCandidate,
  context?: EntityAdmissionContext
): EntityResolution {
  const decision = assessEntityCandidate(candidate, context)
  if (!decision.admitted) return decision
  return getEntityDomain().resolve(decision.candidate, context)
}

export function deleteEntityById(entityId: number): boolean {
  return getEntityDomain().delete(entityId)
}
