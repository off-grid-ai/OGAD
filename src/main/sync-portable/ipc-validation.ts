import type { CollisionPolicy } from '@offgrid/sync/portable'

const POLICIES = new Set<CollisionPolicy>([
  'keep-existing',
  'replace-existing',
  'duplicate',
  'reject'
])

export function boundedId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) {
    throw new Error(`${label} must be a non-empty identifier of at most 512 characters.`)
  }
  return value
}

export function collisionPolicy(value: unknown): CollisionPolicy | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !POLICIES.has(value as CollisionPolicy)) {
    throw new Error('Unsupported workspace collision policy.')
  }
  return value as CollisionPolicy
}
