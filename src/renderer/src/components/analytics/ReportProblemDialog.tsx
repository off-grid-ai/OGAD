import { useEffect, useState } from 'react'
import { Copy, EnvelopeSimple, FolderOpen } from '@phosphor-icons/react'
import { Skeleton } from '@offgrid/operator-ui/operator/coss/skeleton'
import { TextMorph } from '@offgrid/operator-ui/operator/motion/text-morph'
import { writeClipboardWithFallback } from '@renderer/lib/clipboard-write'
import { track } from '@renderer/lib/analytics'
import { Button } from '../ui/button'
import { IconTip } from '../IconTip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

interface ProblemLog {
  path: string
  text: string
  truncated: boolean
}

/**
 * Report a problem: you read the app's diagnostic log before anything leaves, then copy it into an
 * e-mail to support. Works whether or not analytics is on. The log holds app events only, never
 * chat content.
 */
/** Mount it when it opens, so every opening reads the log afresh. */
export function ReportProblemDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.ReactElement {
  const [log, setLog] = useState<ProblemLog | null>(null)
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (!open) return
    let live = true
    void window.api.analytics
      .readLog()
      .then((value) => {
        if (live) setLog(value)
      })
      .catch(() => {
        if (live) setLog({ path: '', text: '', truncated: false })
      })
    return () => {
      live = false
    }
  }, [open])

  const copy = async (): Promise<void> => {
    if (!log?.text) return
    const ok = await writeClipboardWithFallback(log.text, window.api.writeClipboardText, (text) =>
      navigator.clipboard.writeText(text)
    )
    setCopied(ok ? 'copied' : 'failed')
    if (ok) track('problem_reported')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none border-neutral-700 bg-neutral-950 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Report a problem</DialogTitle>
          <DialogDescription className="leading-relaxed">
            This is the app log we would read to fix it. It records what the app did, never what you
            wrote. Copy it, then paste it into the e-mail.
          </DialogDescription>
        </DialogHeader>
        {log === null ? (
          <Skeleton className="h-72 w-full" aria-busy="true" />
        ) : (
          <pre
            aria-label="Diagnostic log"
            tabIndex={0}
            className="h-72 overflow-auto whitespace-pre-wrap break-all rounded-md border border-neutral-800 bg-neutral-900/60 p-3 font-mono text-[10px] leading-relaxed text-neutral-300"
          >
            {log.text || 'The log is empty.'}
          </pre>
        )}
        {log?.truncated ? (
          <p className="text-[11px] text-neutral-500">Showing the newest part of the log.</p>
        ) : null}
        <DialogFooter className="items-center gap-2 sm:justify-between">
          <IconTip label="Show log file">
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Show log file"
              onClick={() => void window.api.analytics.revealLog()}
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          </IconTip>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => void copy()} disabled={!log?.text}>
              <Copy className="h-4 w-4" />
              <TextMorph as="span">
                {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy log'}
              </TextMorph>
            </Button>
            <Button onClick={() => void window.api.analytics.emailLog()}>
              <EnvelopeSimple className="h-4 w-4" />
              Email us
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
