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
import { Button } from '@renderer/components/ui/button'

interface GateRequest {
  actionId: string
  actionType: string
  title: string
  args: Record<string, unknown>
  risk: string
}

interface OutcomeEvent {
  id: string
  outcome: 'done' | 'rejected' | 'needs_help' | 'edited' | 'poisoned'
  record?: { type?: string; intent?: string; attemptLog?: Array<{ detail?: string }> }
  error?: string
  undoable?: boolean
}

const OUTCOME_LABEL: Record<string, string> = {
  done: 'Done - verified',
  rejected: 'Declined',
  needs_help: 'Ran but could not be confirmed - needs your attention',
  poisoned: 'Failed'
}

function riskTone(risk: string): string {
  if (risk === 'irreversible') {
    return 'text-red-500 border-red-500/40'
  }
  return 'text-amber-500 border-amber-500/40'
}

export function ActionGateDock(): React.JSX.Element | null {
  const [pending, setPending] = useState<GateRequest[]>([])
  const [outcomes, setOutcomes] = useState<OutcomeEvent[]>([])
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({})
  const [undone, setUndone] = useState<Record<string, string>>({})

  useEffect(() => {
    const offPending = window.api.actions?.onGatePending((request) => {
      const req = request as GateRequest
      setPending((current) => [...current.filter((p) => p.actionId !== req.actionId), req])
    })
    const offOutcome = window.api.actions?.onOutcome((event) => {
      const outcome = event as OutcomeEvent
      setPending((current) => current.filter((p) => p.actionId !== outcome.id))
      if (outcome.outcome === 'edited') {
        return // the re-gated card arrives as its own pending event
      }
      setOutcomes((current) => [...current.slice(-2), outcome])
    })
    return () => {
      offPending?.()
      offOutcome?.()
    }
  }, [])

  const resolve = (actionId: string, decision: unknown): void => {
    void window.api.actions?.resolveGate(actionId, decision)
  }

  const undo = async (event: OutcomeEvent): Promise<void> => {
    const result = await window.api.actions?.undo(event.record)
    setUndone((current) => ({
      ...current,
      [event.id]: result?.ok ? 'Undone' : (result?.detail ?? 'Undo failed')
    }))
  }

  if (pending.length === 0 && outcomes.length === 0) {
    return null
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-2 px-4 pb-2 font-mono">
      {pending.map((request) => {
        const editing = edits[request.actionId]
        return (
          <div
            key={request.actionId}
            data-testid="gate-card"
            className="rounded-md border border-border bg-card p-3 text-sm"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{request.title}</span>
              <span
                className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${riskTone(request.risk)}`}
              >
                {request.risk}
              </span>
            </div>
            <div className="mt-2 space-y-1">
              {Object.entries(request.args).map(([key, value]) => (
                <div key={key} className="flex items-center gap-2 text-xs">
                  <span className="w-20 shrink-0 text-muted-foreground">{key}</span>
                  {editing ? (
                    <input
                      aria-label={`edit ${key}`}
                      className="w-full rounded border border-border bg-background px-1.5 py-0.5"
                      value={editing[key] ?? String(value ?? '')}
                      onChange={(e) =>
                        setEdits((current) => ({
                          ...current,
                          [request.actionId]: { ...current[request.actionId], [key]: e.target.value }
                        }))
                      }
                    />
                  ) : (
                    <span className="truncate">{String(value ?? '')}</span>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              {editing ? (
                <Button
                  size="sm"
                  onClick={() => {
                    const args = { ...request.args, ...editing }
                    setEdits((current) => {
                      const { [request.actionId]: _dropped, ...rest } = current
                      return rest
                    })
                    resolve(request.actionId, { kind: 'edit', args })
                  }}
                >
                  Save changes
                </Button>
              ) : (
                <>
                  <Button size="sm" onClick={() => resolve(request.actionId, { kind: 'approve' })}>
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setEdits((current) => ({ ...current, [request.actionId]: {} }))
                    }
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => resolve(request.actionId, { kind: 'reject', reason: 'declined in chat' })}
                  >
                    Reject
                  </Button>
                </>
              )}
            </div>
          </div>
        )
      })}
      {outcomes.map((event) => (
        <div
          key={event.id}
          data-testid="outcome-row"
          className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs"
        >
          <span className={event.outcome === 'done' ? 'text-primary' : 'text-muted-foreground'}>
            {event.record?.intent ? `${event.record.intent} - ` : ''}
            {undone[event.id] ?? OUTCOME_LABEL[event.outcome] ?? event.outcome}
            {event.outcome === 'poisoned' && event.error ? ` (${event.error})` : ''}
          </span>
          <span className="flex items-center gap-1">
            {event.undoable && !undone[event.id] ? (
              <Button size="sm" variant="outline" onClick={() => void undo(event)}>
                Undo
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              aria-label="Dismiss"
              onClick={() => setOutcomes((current) => current.filter((o) => o.id !== event.id))}
            >
              x
            </Button>
          </span>
        </div>
      ))}
    </div>
  )
}
