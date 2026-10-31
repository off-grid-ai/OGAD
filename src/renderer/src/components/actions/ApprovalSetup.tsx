import { useMemo, useState, type FormEvent } from 'react'
import { ArrowLeft, CheckCircle } from '@phosphor-icons/react'
import { Card } from '@offgrid/operator-ui/operator/coss/card'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const FIELD_LABEL = 'text-[10px] uppercase tracking-widest text-muted-foreground'
const FIELD_CONTROL =
  'mt-2 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-xs normal-case tracking-normal text-foreground outline-none transition-[border-color,box-shadow] duration-300 focus:border-primary focus:ring-[3px] focus:ring-primary/15'

export interface ApprovalSetupRecord {
  id: number
  title: string
  detail: string | null
  connector: string | null
  tool: string | null
  args: string | null
}

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
  } catch {
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
    // Its own provider: the setup card also renders outside the app shell's provider.
    <TooltipProvider delayDuration={300}>
      <Card className="w-full text-left">
        <form
          onSubmit={submit}
          className="p-6"
          aria-labelledby={`approval-setup-${record.id}`}
          data-testid={`approval-intake-${record.id}`}
        >
          <div className="mb-6 flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-primary">
              <CheckCircle className="h-4 w-4" />
            </span>
            <div>
              <p className={FIELD_LABEL}>Review action</p>
              <h2 id={`approval-setup-${record.id}`} className="mt-1.5 text-base text-foreground">
                Add the final details, then start it in Chat
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-neutral-500">
                This uses the same task flow as Assistant. You can edit everything before it starts.
              </p>
            </div>
          </div>

          <div className="grid gap-x-6 gap-y-5 @3xl:grid-cols-2">
            <label className={`@3xl:col-span-2 ${FIELD_LABEL}`}>
              What should Off Grid AI do? *
              <textarea
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                required
                rows={2}
                className={`${FIELD_CONTROL} min-h-16`}
              />
            </label>
            <label className={`@3xl:col-span-2 ${FIELD_LABEL}`}>
              Useful context
              <textarea
                value={context}
                onChange={(event) => setContext(event.target.value)}
                rows={3}
                className={`${FIELD_CONTROL} min-h-20`}
              />
            </label>
            {Object.entries(args).map(([key, value]) => (
              <label key={key} className={FIELD_LABEL}>
                {key.replaceAll('_', ' ')} *
                <textarea
                  value={value}
                  onChange={(event) =>
                    setArgs((current) => ({ ...current, [key]: event.target.value }))
                  }
                  required
                  rows={key === 'body' || value.length > 80 ? 3 : 1}
                  className={FIELD_CONTROL}
                />
              </label>
            ))}
          </div>

          <div className="mt-6 flex items-center justify-between gap-3 border-t border-neutral-900 pt-4">
            <span className="text-xs text-muted-foreground">* Required before the task starts</span>
            <div className="flex gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Back"
                    onClick={onCancel}
                  >
                    <ArrowLeft />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Back</TooltipContent>
              </Tooltip>
              <Button type="submit" size="sm" disabled={!canStart}>
                Start in chat
              </Button>
            </div>
          </div>
        </form>
      </Card>
    </TooltipProvider>
  )
}
