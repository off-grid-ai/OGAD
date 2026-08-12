import type { SharedFileDescriptor } from '@offgrid/sync'
import { callHook, HOOKS } from './bootstrap/hookRegistry'

export interface LocalSharedFileMutation {
  kind: 'put' | 'delete'
  file: SharedFileDescriptor
  filePath?: string
}

/** Core file owners publish committed app-owned media; Pro optionally replicates it. */
export function emitSharedFileMutation(mutation: LocalSharedFileMutation): void {
  try {
    callHook(HOOKS.syncSharedFileMutation, mutation)
  } catch (error) {
    console.error('[sync] Failed to record committed shared file', mutation.file.syncId, error)
  }
}
