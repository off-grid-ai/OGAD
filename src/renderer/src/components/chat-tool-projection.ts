const TASK_REFERENCE = /(?:^|\s)Task reference:\s*([A-Za-z0-9_-]+)\.?/i

/** Web Use and Computer Use answer the model with launch notes written for it ("Do not call
 *  web_use again"). The transcript shows the plain outcome; the row links to the task itself. */
const TASK_LAUNCH_NOTICES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:Web|Computer) Use started\. Live progress\b/i, 'Task started.'],
  [/^A matching task is already in flight\b/i, 'This task is already running.'],
  [/Waiting for the user's approval in Action Approval\b/i, 'Waiting for your approval.']
]

export function taskReferenceFromResult(result: string | undefined): string | undefined {
  return result?.match(TASK_REFERENCE)?.[1]
}

export function visibleToolResult(result: string | undefined): string {
  const text = (result ?? '').replace(TASK_REFERENCE, '').trim()
  return TASK_LAUNCH_NOTICES.find(([pattern]) => pattern.test(text))?.[1] ?? text
}
