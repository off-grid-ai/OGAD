import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { ArrowUp, FileText, ImageSquare, Paperclip, X } from '@phosphor-icons/react'
import { Button } from '@renderer/components/ui/button'
import { submitTaskGuidance } from '@renderer/lib/task-guidance-client'
import {
  isTaskGuideAttachmentNameAllowed,
  TASK_GUIDE_ATTACHMENT_ACCEPT,
  TASK_GUIDE_MAX_ATTACHMENTS,
  TASK_GUIDE_MAX_ATTACHMENT_BYTES,
  TASK_GUIDE_MAX_TEXT_CHARS,
  TASK_GUIDE_MAX_TOTAL_ATTACHMENT_BYTES,
  type TaskGuideAttachmentInput
} from '../../../../../shared/task-guidance'

const TEXTAREA_MIN_HEIGHT_PX = 40
const TEXTAREA_MAX_HEIGHT_PX = 112

interface SelectedGuideAttachment extends TaskGuideAttachmentInput {
  id: string
  bytes: ArrayBuffer
}

function fileSizeLabel(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.ceil(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function TaskGuideComposer({
  taskId,
  journeyId
}: {
  taskId: string
  journeyId?: string
}): React.JSX.Element | null {
  const [available, setAvailable] = useState(false)
  const [availabilityReason, setAvailabilityReason] = useState('Checking live guidance…')
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<SelectedGuideAttachment[]>([])
  const [readingFiles, setReadingFiles] = useState(false)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [sending, setSending] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [error, setError] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setAccepted(false)
    let active = true
    const tasks = window.api.tasks as Partial<NonNullable<typeof window.api.tasks>> | undefined
    const availability = tasks?.guideAvailability
    if (!availability) {
      setAvailabilityReason('Restart Off Grid AI to enable live guidance for new tasks.')
      return
    }
    void availability(taskId)
      .then((result) => {
        if (!active) return
        setAvailable(result.available)
        setAvailabilityReason(
          result.available ? '' : result.reason || 'This running task cannot accept live guidance.'
        )
      })
      .catch(() => {
        if (active) {
          setAvailable(false)
          setAvailabilityReason('Live guidance could not connect to this task.')
        }
      })
    return () => {
      active = false
    }
  }, [taskId])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const contentHeight = Math.max(TEXTAREA_MIN_HEIGHT_PX, textarea.scrollHeight)
    textarea.style.height = `${Math.min(contentHeight, TEXTAREA_MAX_HEIGHT_PX)}px`
    textarea.style.overflowY = contentHeight > TEXTAREA_MAX_HEIGHT_PX ? 'auto' : 'hidden'
  }, [text])

  useEffect(() => {
    if (!available || sending || !accepted) return
    textareaRef.current?.focus()
  }, [accepted, available, sending])

  const addFiles = async (chosen: File[]): Promise<void> => {
    if (!chosen.length) return
    setAccepted(false)
    setError('')
    const remainingCount = TASK_GUIDE_MAX_ATTACHMENTS - attachments.length
    if (remainingCount <= 0 || chosen.length > remainingCount) {
      setError(`Attach up to ${TASK_GUIDE_MAX_ATTACHMENTS} files at a time.`)
      return
    }
    let selectedBytes = attachments.reduce(
      (total, attachment) => total + attachment.bytes.byteLength,
      0
    )
    for (const file of chosen) {
      if (!isTaskGuideAttachmentNameAllowed(file.name)) {
        setError(`${file.name} is not a supported guidance attachment.`)
        return
      }
      if (file.size === 0) {
        setError(`${file.name} is empty.`)
        return
      }
      if (file.size > TASK_GUIDE_MAX_ATTACHMENT_BYTES) {
        setError(`${file.name} is larger than 5 MB.`)
        return
      }
      selectedBytes += file.size
      if (selectedBytes > TASK_GUIDE_MAX_TOTAL_ATTACHMENT_BYTES) {
        setError('Guidance attachments must total 12 MB or less.')
        return
      }
    }
    setReadingFiles(true)
    try {
      const next = await Promise.all(
        chosen.map(async (file) => ({
          id: crypto.randomUUID(),
          name: file.name,
          mimeType: file.type || undefined,
          bytes: await file.arrayBuffer()
        }))
      )
      setAttachments((current) => [...current, ...next])
    } catch {
      setError('One attachment could not be read. Remove it and try again.')
    } finally {
      setReadingFiles(false)
    }
  }

  const onFileInput = (event: ChangeEvent<HTMLInputElement>): void => {
    const chosen = Array.from(event.target.files ?? [])
    event.target.value = ''
    void addFiles(chosen)
  }

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!available || sending || readingFiles) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDraggingFiles(true)
  }

  const onDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDraggingFiles(false)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDraggingFiles(false)
    if (!available || sending || readingFiles) return
    void addFiles(Array.from(event.dataTransfer.files ?? []))
  }

  const submit = async (): Promise<void> => {
    const guidance = text.trim()
    if ((!guidance && attachments.length === 0) || sending || readingFiles) return
    setSending(true)
    setAccepted(false)
    setError('')
    try {
      const result = await submitTaskGuidance({
        taskId,
        journeyId,
        text: guidance,
        attachments: attachments.map(({ name, mimeType, bytes }) => ({ name, mimeType, bytes }))
      })
      if (result.accepted) {
        setText('')
        setAttachments([])
        setAccepted(true)
      } else {
        setError(result.reason || 'The task did not accept this guidance.')
      }
    } catch {
      setError('Guidance could not be sent. Try again while this task is running.')
    } finally {
      setSending(false)
    }
  }

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault()
    void submit()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    void submit()
  }

  return (
    <form
      onSubmit={onSubmit}
      className="sticky bottom-0 border-t border-border bg-background p-2.5"
      aria-label="Guide running task"
    >
      {attachments.length ? (
        <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Guidance attachments">
          {attachments.map((attachment) => {
            const image = attachment.mimeType?.startsWith('image/')
            return (
              <div
                key={attachment.id}
                className="flex min-w-0 max-w-full items-center gap-1.5 border border-border bg-muted px-2 py-1 text-[10px] text-foreground"
              >
                {image ? <ImageSquare size={13} /> : <FileText size={13} />}
                <span className="max-w-40 truncate" title={attachment.name}>
                  {attachment.name}
                </span>
                <span className="text-muted-foreground">
                  {fileSizeLabel(attachment.bytes.byteLength)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setAccepted(false)
                    setAttachments((current) =>
                      current.filter((candidate) => candidate.id !== attachment.id)
                    )
                  }}
                  aria-label={`Remove ${attachment.name}`}
                  className="text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-500"
                >
                  <X size={12} />
                </button>
              </div>
            )
          })}
        </div>
      ) : null}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={TASK_GUIDE_ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={onFileInput}
      />
      <div
        data-focus-surface="task-guide-composer"
        className={`relative overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm transition-colors focus-within:border-ring ${
          draggingFiles ? 'border-primary bg-primary/5' : 'border-input'
        }`}
        onDragEnter={onDragOver}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        aria-label="Task guidance editor and file drop area"
      >
        <textarea
          ref={textareaRef}
          aria-label="Task guidance"
          placeholder={
            available ? 'Guide this task…' : 'Live guidance is unavailable for this run.'
          }
          value={text}
          onChange={(event) => {
            setAccepted(false)
            setText(event.target.value)
          }}
          onKeyDown={onKeyDown}
          disabled={sending || !available}
          rows={1}
          maxLength={TASK_GUIDE_MAX_TEXT_CHARS}
          className="block min-h-[64px] w-full resize-none bg-transparent px-3.5 pt-3 text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center justify-between px-2.5 pb-2.5 pt-1">
          <Button
            type="button"
            variant="outline"
            size="icon"
            disabled={!available || sending || readingFiles}
            aria-label="Attach guidance files"
            onClick={() => fileInputRef.current?.click()}
            className="h-8 w-8 rounded-full"
          >
            <Paperclip size={14} />
          </Button>
          <Button
            type="submit"
            size="icon"
            disabled={
              !available || sending || readingFiles || (!text.trim() && attachments.length === 0)
            }
            aria-label={sending ? 'Sending task guidance' : 'Send task guidance'}
            className="h-8 w-8 rounded-full"
          >
            <ArrowUp size={14} />
          </Button>
        </div>
        {draggingFiles ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/90 text-[10px] uppercase tracking-wide text-green-500">
            Drop files here
          </div>
        ) : null}
      </div>
      <p className="mt-1.5 text-[9px] text-muted-foreground">
        {available ? 'Enter sends. Shift+Enter adds a line.' : availabilityReason}
      </p>
      {readingFiles ? (
        <p role="status" className="mt-1 text-[10px] text-muted-foreground">
          Reading attachments…
        </p>
      ) : sending ? (
        <p role="status" className="mt-1 text-[10px] text-muted-foreground">
          Sending guidance…
        </p>
      ) : accepted ? (
        <p role="status" className="mt-1 text-[10px] text-muted-foreground">
          Guidance accepted. Applying it to the next decision.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-[10px] text-red-500">
          {error}
        </p>
      ) : null}
    </form>
  )
}
