const TASK_REFERENCE = /(?:^|\s)Task reference:\s*([A-Za-z0-9_-]+)\.?/i

export function taskReferenceFromResult(result: string | undefined): string | undefined {
  return result?.match(TASK_REFERENCE)?.[1]
}

export function visibleToolResult(result: string | undefined): string {
  return (result ?? '').replace(TASK_REFERENCE, '').trim()
}
