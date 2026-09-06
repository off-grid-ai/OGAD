import { useMemo, useState, type FormEvent } from 'react'
import {
  ArrowCounterClockwiseIcon,
  ArrowLeft,
  CheckCircle,
  WarningCircleIcon
} from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import type { ApprovalSetupRecord } from '@renderer/lib/approval-intake'

const placeholder = (value: string): boolean => /^\s*(?:<[^>]+>|\[[^\]]+\])\s*$/.test(value)

function parsedArgs(record: ApprovalSetupRecord): Record<string, string> {
  try {
    const value = record.args ? JSON.parse(record.args) : {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => {
        const text = typeof item === 'string' ? item : JSON.stringify(item)
        return [key, placeholder(text) ? '' : text]
      })
    )
  } catch (cause: unknown) {
    console.error('Approval arguments could not be parsed:', cause)
    return {}
  }
}

function buildApprovalChatPrompt(
  record: ApprovalSetupRecord,
  instruction: string,
  context: string,
  args: Record<string, string>
): string {
  const inputs = Object.entries(args).flatMap(([key, value]) => [
    `${key}: ${value.trim() || 'Not provided'}`
  ])
  return [
    'Complete this approved action now.',
    '',
    `Action: ${instruction.trim()}`,
    context.trim() ? `Context: ${context.trim()}` : '',
    record.connector ? `Preferred integration: ${record.connector}` : '',
    record.tool ? `Requested operation: ${record.tool}` : '',
    inputs.length ? 'User-approved inputs:' : '',
    ...inputs,
    '',
    'Use the normal task path. Use a working direct tool when one is available; otherwise use Computer Use. Do not ask for details already supplied above. Show normal task progress, controls, retry, and the verified result in this chat.'
  ]
    .filter(Boolean)
    .join('\n')
}

export function ApprovalSetup({
  record,
  onSubmit,
  onCancel
}: {
  record: ApprovalSetupRecord
  onSubmit: (prompt: string) => void
  onCancel: () => void
}): React.ReactElement {
  const initialArgs = useMemo(() => parsedArgs(record), [record])
  const [instruction, setInstruction] = useState(record.title)
  const [context, setContext] = useState(record.detail ?? '')
  const [args, setArgs] = useState(initialArgs)
  const canStart = Boolean(instruction.trim()) && Object.values(args).every((value) => value.trim())

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!canStart) return
    onSubmit(buildApprovalChatPrompt(record, instruction, context, args))
  }

  return (
    <form
      onSubmit={submit}
      className="w-full max-w-4xl rounded-md border border-border bg-card p-4 text-left text-card-foreground"
      aria-labelledby={`approval-setup-${record.id}`}
      data-testid={`approval-intake-${record.id}`}
    >
      <div className="mb-4 flex items-start gap-3 border-b border-border pb-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-primary">
          <CheckCircle className="h-4 w-4" />
        </span>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Review action</p>
          <h2 id={`approval-setup-${record.id}`} className="mt-0.5 text-sm text-foreground">
            Add the final details, then start it in Chat
          </h2>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            This uses the same task flow as Explore. You can edit everything before it starts.
          </p>
        </div>
      </div>

      <div className="grid gap-3 @3xl:grid-cols-2">
        <label className="@3xl:col-span-2 text-[10px] uppercase tracking-wide text-muted-foreground">
          What should Off Grid AI do? *
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            required
            rows={2}
            className="mt-1 min-h-16 w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-xs normal-case text-foreground outline-none focus:border-primary"
          />
        </label>
        <label className="@3xl:col-span-2 text-[10px] uppercase tracking-wide text-muted-foreground">
          Useful context
          <textarea
            value={context}
            onChange={(event) => setContext(event.target.value)}
            rows={3}
            className="mt-1 min-h-20 w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-xs normal-case text-foreground outline-none focus:border-primary"
          />
        </label>
        {Object.entries(args).map(([key, value]) => (
          <label key={key} className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {key.replaceAll('_', ' ')} *
            <textarea
              value={value}
              onChange={(event) =>
                setArgs((current) => ({ ...current, [key]: event.target.value }))
              }
              required
              rows={key === 'body' || value.length > 80 ? 3 : 1}
              className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-xs normal-case text-foreground outline-none focus:border-primary"
            />
          </label>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
        <span className="text-[10px] text-muted-foreground">* Required before the task starts</span>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            <ArrowLeft /> Back
          </Button>
          <Button type="submit" size="sm" disabled={!canStart}>
            Start in chat
          </Button>
        </div>
      </div>
    </form>
  )
}

export function ApprovalIntakeFailure({
  message,
  onRetry,
  onCancel
}: {
  message: string
  onRetry: () => void
  onCancel: () => void
}): React.ReactElement {
  return (
    <section
      aria-labelledby="approval-intake-error-title"
      className="w-full max-w-xl rounded-md border border-red-500/40 bg-card p-4 text-left text-card-foreground"
    >
      <div className="flex items-start gap-3">
        <WarningCircleIcon className="mt-0.5 h-5 w-5 shrink-0 text-red-400" aria-hidden="true" />
        <div>
          <h2 id="approval-intake-error-title" className="text-sm text-foreground">
            Approval could not be opened
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{message}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            The approval is unchanged. Retry the read or return to Approvals.
          </p>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2 border-t border-border pt-3">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          <ArrowLeft /> Close
        </Button>
        <Button type="button" size="sm" onClick={onRetry}>
          <ArrowCounterClockwiseIcon /> Retry
        </Button>
      </div>
    </section>
  )
}
