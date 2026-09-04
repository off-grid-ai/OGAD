import type { ModelModality } from '@offgrid/models'

export function modelSearchKind(value: unknown): ModelModality | undefined {
  switch (value) {
    case 'text':
    case 'vision':
    case 'computer_use':
    case 'image':
    case 'voice':
    case 'transcription':
    case 'embedding':
    case 'classifier':
    case 'tool_selection':
      return value
    default:
      return undefined
  }
}
