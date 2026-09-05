/**
 * The inline action surface (Approval UX v2, R2-B3): pending gate cards and
 * recent outcomes, in the conversation flow above the composer.
 *
 * A gated action renders as a card - the resolved values, the risk, and
 * Approve / Edit / Reject - resolved through the engine gate, so what you
 * approve is byte-for-byte what runs. Outcomes land back here: a verified
 * confirmation with Undo when the handler can reverse the effect, or the
 * honest failure. Auto-run reversibles skip the card and appear directly as
 * an undoable confirmation.
 *
 * Self-contained on purpose: it subscribes to the preload feed and never
 * touches the chat's message model, so non-action turns are untouched.
 */
import { useEffect, useState } from 'react'
import type { ActionRecord, UseSnapshot } from '@offgrid/application'
import { Button } from '@renderer/components/ui/button'
import { presentActionApproval } from './action-approval-presentation'

interface GateRequest {
  actionId: string
  actionType: string
  title: string
  args: Record<string, unknown>
  risk: string
  sourceRef?: string
}

const EMPTY_PROJECTION: UseSnapshot = { actions: [], active: [], recoverable: [], running: false }

const gateRequestFrom = (record: ActionRecord): GateRequest => ({
  actionId: record.id,
  actionType: record.type,
  title: record.intent,
  args: record.args,
  risk: record.risk,
  sourceRef: record.sourceRef
})

export function ActionGateDock({
  conversationId
}: Readonly<{ conversationId: string | null }>): React.JSX.Element | null {
  const [projection, setProjection] = useState<UseSnapshot>(EMPTY_PROJECTION)
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({})

  useEffect(() => {
    const actions = window.api.actions
    if (!actions) return
    let updates = 0
    let mounted = true
    const offProjection = actions.onProjection((snapshot) => {
      updates += 1
      setProjection(snapshot)
    })
    const updatesBeforeRead = updates
    void actions.getProjection().then((snapshot) => {
      if (mounted && updates === updatesBeforeRead) setProjection(snapshot)
    })
    return () => {
      mounted = false
      offProjection()
    }
  }, [])

  const resolve = (actionId: string, decision: unknown): void => {
    void window.api.actions?.resolveGate(actionId, decision)
  }

  // sourceRef is the task's existing Chat owner. The same rule applies in free
  // and Pro builds, and a different open Chat cannot display or decide this gate.
  const visiblePending = projection.active
    .filter((record) => record.state === 'awaiting_approval')
    .map(gateRequestFrom)
    .filter((request) => conversationId !== null && request.sourceRef === conversationId)
  const visibleRecoverable = projection.recoverable.filter(
    (entry) => conversationId !== null && entry.record.sourceRef === conversationId
  )
  if (visiblePending.length === 0 && visibleRecoverable.length === 0) {
    return null
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-2 px-4 pb-2 font-mono">
      {visiblePending.map((request) => {
        const editing = edits[request.actionId]
        const presentation = presentActionApproval(request)
        return (
          <div
            key={request.actionId}
            data-testid="gate-card"
            className="rounded-md border border-border bg-card p-3 text-sm"
          >
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Approval needed
            </div>
            <div className="mt-1 font-medium text-foreground">{presentation.title}</div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {presentation.description}
            </div>
            <div className="mt-3 space-y-2">
              {presentation.details.map((detail) => (
                <div key={detail.key} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2 text-xs">
                  <span className="text-muted-foreground">{detail.label}</span>
                  {editing ? (
                    <input
                      aria-label={`edit ${detail.label.toLowerCase()}`}
                      className="w-full rounded border border-border bg-background px-1.5 py-0.5"
                      value={editing[detail.key] ?? detail.editValue}
                      onChange={(e) =>
                        setEdits((current) => ({
                          ...current,
                          [request.actionId]: {
                            ...current[request.actionId],
                            [detail.key]: e.target.value
                          }
                        }))
                      }
                    />
                  ) : (
                    <span className="break-words text-foreground">{detail.value}</span>
                  )}
                </div>
              ))}
            </div>
            {presentation.warning ? (
              <div className="mt-3 text-xs text-amber-600 dark:text-amber-400">
                {presentation.warning}
              </div>
            ) : null}
            <div className="mt-3 flex items-center gap-2">
              {editing ? (
                <Button
                  size="sm"
                  onClick={() => {
                    const args = { ...request.args, ...editing }
                    setEdits((current) => {
                      const remaining = { ...current }
                      delete remaining[request.actionId]
                      return remaining
                    })
                    resolve(request.actionId, { kind: 'edit', args })
                  }}
                >
                  Save changes
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    disabled={!presentation.canApprove}
                    onClick={() => resolve(request.actionId, { kind: 'approve' })}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEdits((current) => ({ ...current, [request.actionId]: {} }))}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      resolve(request.actionId, { kind: 'reject', reason: 'declined in chat' })
                    }
                  >
                    Reject
                  </Button>
                </>
              )}
            </div>
          </div>
        )
      })}
      {visibleRecoverable.map((event) => (
        <div
          key={event.actionId}
          data-testid="outcome-row"
          className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs"
        >
          <span className="text-muted-foreground">
            {event.record.intent} - Ran but could not be confirmed - needs your attention
            {event.record.attemptLog.at(-1)?.detail
              ? ` (${event.record.attemptLog.at(-1)?.detail})`
              : ''}
          </span>
          <span className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void window.api.actions?.retry(event.actionId)}
            >
              Retry
            </Button>
          </span>
        </div>
      ))}
    </div>
  )
}
