import type { SharedFileDescriptor } from '@offgrid/sync'
import { callHookAsync, hasHook, HOOKS } from './bootstrap/hookRegistry'

export interface LocalSharedFileMutation {
  kind: 'put' | 'delete'
  file: SharedFileDescriptor
  filePath?: string
}

/** Core file owners publish committed app-owned media; Pro optionally replicates it. */
export async function emitSharedFileMutation(mutation: LocalSharedFileMutation): Promise<boolean> {
  if (!hasHook(HOOKS.syncSharedFileMutation)) return false
  await callHookAsync(HOOKS.syncSharedFileMutation, mutation)
  return true
}
