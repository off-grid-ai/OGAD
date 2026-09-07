import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { LoadingDots } from './ui/loading-dots'

type MigrationSnapshot = Awaited<
  ReturnType<typeof window.api.workspaceContent.migration.getSnapshot>
>

type NoticeState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'read_failed' }
  | { readonly phase: 'snapshot'; readonly snapshot: MigrationSnapshot }

const INITIAL_READ_TIMEOUT_MS = 10_000

export function WorkspaceContentMigrationNotice(): React.JSX.Element | null {
  const [state, setState] = useState<NoticeState>({ phase: 'loading' })
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    let live = true
    const deadline = window.setTimeout(() => {
      if (live) setState({ phase: 'read_failed' })
    }, INITIAL_READ_TIMEOUT_MS)
    const apply = (snapshot: MigrationSnapshot): void => {
      if (!live) return
      window.clearTimeout(deadline)
      setState({ phase: 'snapshot', snapshot })
    }
    const unsubscribe = window.api.workspaceContent.migration.onSnapshot(apply)
    void window.api.workspaceContent.migration
      .getSnapshot()
      .then(apply)
      .catch(() => {
        if (!live) return
        window.clearTimeout(deadline)
        setState({ phase: 'read_failed' })
      })
    return () => {
      live = false
      window.clearTimeout(deadline)
      unsubscribe()
    }
  }, [])

  if (
    state.phase === 'snapshot' &&
    ['ready', 'not_needed', 'completed'].includes(state.snapshot.phase)
  ) {
    return null
  }

  const retry = async (): Promise<void> => {
    setRetrying(true)
    try {
      const snapshot = await window.api.workspaceContent.migration.retry()
      setState({ phase: 'snapshot', snapshot })
    } catch {
      setState({ phase: 'read_failed' })
    } finally {
      setRetrying(false)
    }
  }

  const failed = state.phase === 'snapshot' && state.snapshot.phase === 'failed'
  const running = state.phase === 'snapshot' && state.snapshot.phase === 'running'

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        className="rounded-none border-neutral-700 bg-neutral-950 font-mono sm:max-w-xl"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <p className="text-xs uppercase tracking-widest text-neutral-500">Local upgrade</p>
          <DialogTitle className="font-normal text-white">
            {failed
              ? 'Your chats could not be upgraded'
              : state.phase === 'read_failed'
                ? 'Upgrade status could not be read'
                : 'Preparing your chats'}
          </DialogTitle>
        </DialogHeader>
        <DialogDescription asChild>
          <div className="text-left text-sm text-neutral-400">
            {running ? (
              <>
                <p>
                  Copying {state.snapshot.preflight.counts.projects} projects and{' '}
                  {state.snapshot.preflight.counts.rag_conversations} conversations with{' '}
                  {state.snapshot.preflight.counts.rag_messages} messages.
                </p>
                <div className="mt-4 flex items-center gap-2 text-emerald-400" role="status">
                  <span>Upgrade running</span>
                  <LoadingDots size="small" />
                </div>
              </>
            ) : failed ? (
              <>
                <p>Nothing was removed. {state.snapshot.message}</p>
                {state.snapshot.retryable ? (
                  <Button className="mt-5" onClick={() => void retry()} disabled={retrying}>
                    {retrying ? 'Retrying' : 'Retry upgrade'}
                  </Button>
                ) : (
                  <p className="mt-4 text-neutral-300">
                    Your saved chats need repair before the upgrade can continue.
                  </p>
                )}
              </>
            ) : state.phase === 'read_failed' ? (
              <p>Restart Off Grid AI Desktop. Your saved chats have not been changed.</p>
            ) : (
              <div className="flex items-center gap-2" role="status">
                <span>Reading your saved chats</span>
                <LoadingDots size="small" />
              </div>
            )}
          </div>
        </DialogDescription>
      </DialogContent>
    </Dialog>
  )
}
