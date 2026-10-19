import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowSquareOut,
  MagnifyingGlass,
  SlidersHorizontal,
  Eye,
  ArrowUpRight,
  ArrowDownLeft,
  ArrowClockwise,
  Trash,
  HardDrives,
  Pulse,
  Pause,
  ListMagnifyingGlass,
  ArrowCounterClockwise,
  CaretLeft,
  CaretRight,
  Key as KeyIcon
} from '@phosphor-icons/react'
import {
  AI_LOG_POLICY,
  AI_MODALITIES,
  type AILogAttachment,
  type AILogQuery,
  type AILogPage,
  type AIRequestRecord,
  type AIRequestSummary
} from '@offgrid/core/shared/ai-request-log'
import { Button } from './ui/button'
import { GlyphSwap, IconTip } from './IconTip'
import { AnimatePresence, motion } from 'motion/react'
import { Segmented } from '@offgrid/operator-ui/operator/segmented'
import { PageHeader } from '@offgrid/operator-ui/operator/experience'
import { TextMorph } from '@offgrid/operator-ui/operator/motion/text-morph'
import { AnimatedNumber } from '@offgrid/operator-ui/operator/motion/animated-number'
import { Skeleton } from '@offgrid/operator-ui/operator/coss/skeleton'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@offgrid/operator-ui/operator/coss/empty'
import { Table, TableBody, TableHeader, TableRow } from '@offgrid/operator-ui/operator/coss/table'
import { TableVirtuoso, type TableComponents } from '@offgrid/operator-ui/operator/virtual-list'
import { AutoHeight, Highlight, LiveStatus } from '@offgrid/operator-ui/operator/presence'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput
} from '@offgrid/operator-ui/operator/coss/input-group'
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue
} from '@offgrid/operator-ui/operator/coss/select'
import { SettingsSelect } from './SettingsSelect'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import { Checkbox } from '@offgrid/operator-ui/operator/animate/checkbox'
import { CopyButton } from './ui/CopyButton'
import { AudioClip } from './AudioClip'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel
} from './ui/dropdown-menu'

const labels = {
  text: 'Text & vision',
  image: 'Images',
  tts: 'Voice',
  stt: 'Transcription',
  embedding: 'Embeddings'
}
const initialDisplay = { request: true, response: true, model: true, details: true }
type Display = typeof initialDisplay
const duration = (ms?: number): string =>
  ms === undefined ? 'In progress' : `${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)}s`
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Could not load activity. Try Refresh.'
const ease = [0.16, 1, 0.3, 1] as const
const spring = { type: 'spring', stiffness: 420, damping: 36 } as const
const STATUS_DOT: Record<string, string> = {
  completed: 'bg-primary shadow-[0_0_6px_rgb(var(--og-rgb-primary)/0.8)]',
  running: 'bg-primary/70 animate-pulse',
  failed: 'bg-red-400',
  interrupted: 'bg-amber-400',
  cancelled: 'bg-muted-foreground/50'
}

/** What every visible request row needs to know besides its own data. */
interface RowContext {
  selectedId: string | null
  freshIds: ReadonlySet<string>
}

// The virtual chapter's table: Coss parts, a header that stays put, rows that light on hover. The
// Coss container scrolls on x, which would capture the sticky header, so it stays visible here.
function RequestTable({
  context: _context,
  ...props
}: React.ComponentProps<'table'> & { context?: RowContext }): React.ReactElement {
  return (
    <Table
      {...props}
      render={<div style={{ overflow: 'visible' }} />}
      className="table-fixed border-separate border-spacing-0"
    />
  )
}

function RequestTableRow({
  item,
  context,
  ...props
}: React.ComponentProps<'tr'> & {
  item: AIRequestSummary
  context: RowContext
}): React.ReactElement {
  return (
    <TableRow
      {...props}
      data-state={context.selectedId === item.id ? 'selected' : undefined}
      className="relative border-0 transition-colors duration-200 hover:bg-foreground/[0.035] data-[state=selected]:bg-primary/[0.05] [&>td]:border-b [&>td]:border-border/40"
    />
  )
}

const requestTableComponents: TableComponents<AIRequestSummary, RowContext> = {
  Table: RequestTable,
  TableHead: TableHeader,
  TableBody,
  TableRow: RequestTableRow
}

function readDisplay(): Display {
  try {
    const stored = JSON.parse(window.localStorage.getItem('ai-activity-display') || '{}')
    return Object.fromEntries(
      Object.entries(initialDisplay).map(([key, value]) => [
        key,
        typeof stored?.[key] === 'boolean' ? stored[key] : value
      ])
    ) as Display
  } catch {
    return initialDisplay
  }
}

/** Human-readable projection; Raw preserves the bounded stored payload. */
function readableAIValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return 'Not recorded'
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'number'))
      return `${value.length} values\n${JSON.stringify(value)}`
    return value.map(readableAIValue).join('\n\n')
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    if (object.attachment) return 'Media attachment (open below)'
    if (object.result !== undefined)
      return (
        readableAIValue(object.result) +
        (object.reasoning ? `\n\nReasoning\n${readableAIValue(object.reasoning)}` : '')
      )
    if (object.choices) return readableAIValue(object.choices)
    if (object.message) return readableAIValue(object.message)
    if (object.messages) return readableAIValue(object.messages)
    if (object.content !== undefined)
      return `${object.role ? `${object.role}\n` : ''}${readableAIValue(object.content)}${object.toolCalls ? `\n\nTool calls\n${JSON.stringify(object.toolCalls, null, 2)}` : ''}`
    if (object.text !== undefined) return readableAIValue(object.text)
    if (object.prompt !== undefined) return readableAIValue(object.prompt)
  }
  return JSON.stringify(value, null, 2)
}

function Payload({ title, value }: { title: string; value: unknown }): React.ReactElement {
  const text = readableAIValue(value)
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? text : text.slice(0, 6000)
  return (
    <section className="min-w-0 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-normal">
          {title === 'Request' ? <ArrowUpRight /> : <ArrowDownLeft />}
          {title}
        </h3>
        <CopyButton text={text} label={`Copy ${title.toLowerCase()}`} />
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-4 font-mono text-sm leading-relaxed text-foreground">
        {shown}
      </pre>
      {text.length > 6000 && (
        <Button variant="ghost" size="xs" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show less' : `Show all (${text.length.toLocaleString()} characters)`}
        </Button>
      )}
    </section>
  )
}

function Attachment({
  recordId,
  asset
}: {
  recordId: string
  asset: AILogAttachment
}): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  async function load(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const result = await window.api.aiLogsAttachment(recordId, asset.id)
      if (!result) throw new Error('This media is no longer available.')
      setUrl(result)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-all text-xs text-muted-foreground">
          {asset.mime} · {(asset.bytes / 1024).toFixed(0)} KB
        </span>
        <Button
          variant="outline"
          size="xs"
          disabled={loading}
          onClick={() => (url ? setUrl(null) : void load())}
        >
          <TextMorph as="span">
            {loading ? 'Loading media...' : url ? 'Hide media' : 'Open media'}
          </TextMorph>
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-muted-foreground">
          {error}
        </p>
      )}
      {url &&
        (asset.mime.startsWith('image/') ? (
          <img
            src={url}
            alt="AI request or response attachment"
            className="max-h-96 max-w-full rounded-md object-contain"
          />
        ) : (
          <AudioClip src={url} />
        ))}
    </div>
  )
}

function RequestDetail({
  record,
  display,
  raw
}: {
  record: AIRequestRecord
  display: Display
  raw: boolean
}): React.ReactElement {
  const [related, setRelated] = useState<AIRequestSummary[]>([])
  useEffect(() => {
    let disposed = false
    void window.api
      .aiLogsRelated(record.id)
      .then((rows) => {
        if (!disposed) setRelated(rows)
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [record.id, record.status])
  const visible = {
    id: record.id,
    parentId: record.parentId,
    modality: record.modality,
    source: record.source,
    ...(record.keyName ? { keyName: record.keyName } : {}),
    status: record.status,
    ...(display.model ? { model: record.model, backend: record.backend } : {}),
    ...(display.request
      ? { request: record.request, effectiveRequest: record.effectiveRequest }
      : {}),
    ...(display.response ? { response: record.response, error: record.error } : {}),
    ...(display.details
      ? {
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
          durationMs: record.durationMs,
          metrics: record.metrics
        }
      : {})
  }
  const attachments = (record.attachments ?? []).filter(
    (asset) =>
      (display.request && /\.(request|effectiveRequest)(\.|$)/.test(asset.label)) ||
      (display.response && /\.response(\.|$)/.test(asset.label))
  )
  return (
    <div className="min-w-0 space-y-3">
      <div>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{record.source}</p>
        <h2 className="mt-2 break-words text-base font-normal">{record.preview}</h2>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{new Date(record.startedAt).toLocaleString()}</span>
          <span>{record.status}</span>
          {record.keyName && (
            <span className="inline-flex items-center gap-1" title="API key">
              <KeyIcon aria-label="API key" className="size-3" />
              {record.keyName}
            </span>
          )}
          {display.details && <span>{duration(record.durationMs)}</span>}
        </div>
        {display.model && (
          <dl className="mt-4 grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4 border-y border-border py-3">
            <div className="min-w-0">
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Model</dt>
              <dd className="mt-1 break-words text-sm">{record.model ?? 'Not reported'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Hardware
              </dt>
              <dd className="mt-1 break-words text-sm">{record.backend ?? 'Not reported'}</dd>
            </div>
          </dl>
        )}
      </div>
      {raw ? (
        <div>
          <CopyButton text={JSON.stringify(visible, null, 2)} label="Copy visible data" />
          <pre className="mt-3 max-h-[36rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 text-xs">
            {JSON.stringify(visible, null, 2)}
          </pre>
        </div>
      ) : (
        <>
          {record.error && display.response && (
            <p role="status" className="border-l-2 border-border bg-muted/30 p-3 text-xs">
              {record.error}
            </p>
          )}
          {display.request && (
            <>
              <Payload title="Request" value={record.request} />
              {record.effectiveRequest !== undefined && (
                <Collapsible className="border-t border-border pt-3">
                  <CollapsibleTrigger className="text-xs">
                    Effective request / parameters
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">
                      {JSON.stringify(record.effectiveRequest, null, 2)}
                    </pre>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </>
          )}
          {display.response && <Payload title="Response" value={record.response} />}
          {display.details && (
            <section className="space-y-2 border-t border-border pt-3">
              <h3 className="text-sm font-normal">Generation details</h3>
              <dl className="grid grid-cols-2 gap-2 text-xs">
                <dt className="text-muted-foreground">Total elapsed</dt>
                <dd>{duration(record.durationMs)}</dd>
                {Object.entries(record.metrics ?? {}).map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="break-words text-muted-foreground">{key}</dt>
                    <dd className="break-all">
                      {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-muted-foreground">
                Unavailable runtime metrics are not estimated.
              </p>
            </section>
          )}
        </>
      )}
      {attachments.map((asset) => (
        <Attachment key={`${record.id}-${asset.id}`} recordId={record.id} asset={asset} />
      ))}
      {display.details && related.length > 0 && (
        <section className="space-y-2 border-t border-border pt-3">
          <h3 className="text-sm font-normal">Related requests / attempts</h3>
          {related.map((row) => (
            <RelatedRequest key={row.id} row={row} display={display} />
          ))}
        </section>
      )}
      <p className="break-all text-[11px] text-muted-foreground">
        {record.id}
        {record.parentId ? ` · Parent ${record.parentId}` : ''}
      </p>
    </div>
  )
}

function RelatedRequest({
  row,
  display
}: {
  row: AIRequestSummary
  display: Display
}): React.ReactElement {
  const [record, setRecord] = useState<AIRequestRecord | null>(null)
  const [error, setError] = useState('')
  return (
    <Collapsible
      className="border-b border-border py-2"
      onOpenChange={(open) => {
        if (open && !record)
          void window.api
            .aiLogsDetail(row.id)
            .then((value) => {
              setRecord(value)
              if (!value) setError('This request is no longer available.')
            })
            .catch((error) => setError(errorMessage(error)))
      }}
    >
      <CollapsibleTrigger className="text-xs">
        {row.source} · {row.status} · {duration(row.durationMs)}
        {display.model ? ` · ${row.backend ?? 'Backend not reported'}` : ''}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 space-y-3">
        {error && (
          <p role="alert" className="text-xs">
            {error}
          </p>
        )}
        {record && (
          <>
            {display.request && <Payload title="Request" value={record.request} />}
            {display.response && (
              <Payload title="Response" value={record.response ?? record.error} />
            )}
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function AIRequestLogs({
  standalone = false
}: {
  standalone?: boolean
}): React.ReactElement {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [modality, setModality] = useState('all')
  const [status, setStatus] = useState('all')
  const [hardware, setHardware] = useState('all')
  const [sort, setSort] = useState('newest')
  const [period, setPeriod] = useState('all')
  const [slow, setSlow] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [display, setDisplay] = useState<Display>(readDisplay)
  const [raw, setRaw] = useState(false)
  const [live, setLive] = useState(true)
  const [offset, setOffset] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [page, setPage] = useState<AILogPage>({ rows: [], total: 0 })
  const [record, setRecord] = useState<AIRequestRecord | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  // Rows that arrived with the latest live refresh glow in once; the first page arrives quietly.
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set())
  const shownIds = useRef<ReadonlySet<string> | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250)
    return () => clearTimeout(timer)
  }, [search])
  useEffect(() => {
    setOffset(0)
  }, [debouncedSearch, modality, status, hardware, sort, period, slow])
  const query = useMemo<AILogQuery>(
    () => ({
      search: debouncedSearch,
      modality: modality === 'all' ? undefined : (modality as AILogQuery['modality']),
      status: status === 'all' ? undefined : (status as AILogQuery['status']),
      hardware: hardware === 'all' ? undefined : (hardware as AILogQuery['hardware']),
      sort: sort as AILogQuery['sort'],
      minDurationMs: slow ? 10000 : undefined,
      offset,
      limit: 30
    }),
    [debouncedSearch, modality, status, hardware, sort, slow, offset]
  )
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const active = (): boolean => !disposed
    async function load(): Promise<void> {
      try {
        const result = await window.api.aiLogsList({
          ...query,
          since:
            period === 'hour'
              ? Date.now() - 3600000
              : period === 'day'
                ? Date.now() - 86400000
                : undefined
        })
        if (disposed) return
        const previous = shownIds.current
        const ids = new Set(result.rows.map((row) => row.id))
        setFreshIds(
          previous ? new Set([...ids].filter((id) => !previous.has(id))) : new Set<string>()
        )
        shownIds.current = ids
        setPage(result)
        setError('')
        const selected = result.rows.some((row) => row.id === selectedId)
          ? selectedId
          : (result.rows[0]?.id ?? null)
        if (selected !== selectedId) {
          setRecord(null)
          setSelectedId(selected)
        } else if (selected) {
          const detail = await window.api.aiLogsDetail(selected)
          if (active()) setRecord(detail)
        } else setRecord(null)
      } catch (error) {
        if (!disposed) setError(errorMessage(error))
      } finally {
        if (!disposed) {
          setLoading(false)
          if (live)
            timer = setTimeout(() => {
              if (document.visibilityState === 'hidden') timer = setTimeout(() => void load(), 2000)
              else void load()
            }, 2000)
        }
      }
    }
    void load()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [query, selectedId, period, live, refresh])
  function toggleDisplay(key: keyof Display): void {
    const next = { ...display, [key]: !display[key] }
    setDisplay(next)
    try {
      window.localStorage.setItem('ai-activity-display', JSON.stringify(next))
    } catch {
      /* Preference storage may be unavailable. */
    }
  }
  async function clear(): Promise<void> {
    setClearing(true)
    try {
      await window.api.aiLogsClear()
      setPage({ rows: [], total: 0 })
      setRecord(null)
      setSelectedId(null)
      setOffset(0)
      setConfirmClear(false)
      setRefresh((value) => value + 1)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setClearing(false)
    }
  }
  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
      <IconTip label="Live updates">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Live updates"
          aria-pressed={live}
          className={live ? 'text-primary' : 'text-muted-foreground'}
          onClick={() => setLive((value) => !value)}
        >
          <GlyphSwap glyphKey={live ? 'live' : 'paused'}>
            {live ? <Pulse aria-hidden /> : <Pause aria-hidden />}
          </GlyphSwap>
        </Button>
      </IconTip>
      <IconTip label="Refresh activity">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh activity"
          onClick={() => setRefresh((value) => value + 1)}
        >
          <ArrowClockwise />
        </Button>
      </IconTip>
      {!standalone && (
        <IconTip label="Open in new window">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Open in new window"
            onClick={() =>
              void window.api.aiLogsOpenWindow().catch((error) => setError(errorMessage(error)))
            }
          >
            <ArrowSquareOut />
          </Button>
        </IconTip>
      )}
    </div>
  )
  return (
    <section
      aria-label="AI activity"
      className={`flex w-full min-w-0 flex-col gap-3 overflow-auto font-mono text-foreground ${standalone ? 'h-full flex-1 bg-background p-6' : 'h-[calc(100dvh-18rem)] min-h-96'}`}
    >
      {standalone ? (
        <PageHeader
          className="shrink-0 pb-4"
          title="AI activity"
          description="Inspect your AI requests and responses."
          actions={headerActions}
        />
      ) : (
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          <p className="mt-1 text-xs text-muted-foreground">
            Inspect your AI requests and responses.
          </p>
          {headerActions}
        </header>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <InputGroup data-focus-surface className="min-w-48 flex-1">
          <InputGroupAddon>
            <MagnifyingGlass aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search requests and responses"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search requests, responses, models..."
          />
        </InputGroup>
        <IconTip label="Filters">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Filters"
            aria-expanded={showFilters}
            aria-controls="ai-log-filters"
            onClick={() => setShowFilters((value) => !value)}
          >
            <SlidersHorizontal />
          </Button>
        </IconTip>
        <DropdownMenu>
          <IconTip label="Show">
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon-sm" aria-label="Show">
                <Eye />
              </Button>
            </DropdownMenuTrigger>
          </IconTip>
          <DropdownMenuContent align="end" className="shadow-none">
            <DropdownMenuLabel className="text-[11px] font-normal uppercase tracking-wide text-muted-foreground">
              Visible fields
            </DropdownMenuLabel>
            {(Object.keys(display) as (keyof Display)[]).map((key) => (
              <DropdownMenuCheckboxItem
                key={key}
                checked={display[key]}
                onCheckedChange={() => toggleDisplay(key)}
                onSelect={(event) => event.preventDefault()}
              >
                {
                  {
                    request: 'Requests',
                    response: 'Responses',
                    model: 'Model & hardware',
                    details: 'Generation details'
                  }[key]
                }
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <AutoHeight className="shrink-0">
        <AnimatePresence initial={false}>
          {showFilters && (
            <motion.div
              key="filters"
              id="ai-log-filters"
              initial={{ opacity: 0, filter: 'blur(4px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, filter: 'blur(4px)' }}
              transition={{ duration: 0.3, ease }}
              className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-muted/20 p-3"
            >
              <Filter
                label="Status"
                value={status}
                onChange={setStatus}
                options={['all', 'running', 'completed', 'failed', 'cancelled', 'interrupted']}
              />
              <Filter
                label="Hardware"
                value={hardware}
                onChange={setHardware}
                options={['all', 'gpu', 'cpu', 'unknown']}
              />
              <Filter
                label="Time"
                value={period}
                onChange={setPeriod}
                options={['all', 'hour', 'day']}
              />
              <label className="flex items-center gap-2 py-2 text-xs">
                <Checkbox checked={slow} onCheckedChange={(checked) => setSlow(checked)} />
                Over 10 seconds
              </label>
              <IconTip label="Reset filters">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Reset filters"
                  onClick={() => {
                    setSearch('')
                    setStatus('all')
                    setHardware('all')
                    setPeriod('all')
                    setSlow(false)
                    setModality('all')
                  }}
                >
                  <ArrowCounterClockwise />
                </Button>
              </IconTip>
            </motion.div>
          )}
        </AnimatePresence>
      </AutoHeight>
      <Segmented
        label="Modality"
        size="sm"
        className="shrink-0 self-start"
        value={modality}
        onValueChange={setModality}
        options={[
          { id: 'all', label: 'All' },
          ...AI_MODALITIES.map((kind) => ({ id: kind as string, label: labels[kind] }))
        ]}
      />
      <AutoHeight className="shrink-0">
        <AnimatePresence initial={false}>
          {(error || page.storageError) && (
            <motion.p
              key="error"
              role="alert"
              initial={{ opacity: 0, filter: 'blur(4px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, filter: 'blur(4px)' }}
              transition={{ duration: 0.3, ease }}
              className="rounded-md border border-border p-3 text-xs"
            >
              {error || page.storageError}
            </motion.p>
          )}
        </AnimatePresence>
      </AutoHeight>
      <div className="grid min-h-64 min-w-0 flex-1 grid-cols-1 overflow-auto rounded-md border border-border bg-background md:grid-cols-[minmax(16rem,1fr)_minmax(0,2fr)] md:overflow-hidden">
        <div
          aria-label="Request list"
          role="region"
          className="flex min-h-64 min-w-0 flex-col overflow-hidden border-b border-border md:min-h-0 md:border-r md:border-b-0"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-muted/20 px-4 py-3">
            <span
              aria-live="polite"
              className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground"
            >
              <AnimatedNumber value={page.total} /> requests
            </span>
            <div className="min-w-0 max-w-44">
              <SettingsSelect
                id="ai-log-sort"
                label="Sort requests"
                value={sort}
                onValueChange={setSort}
                options={[
                  { value: 'newest', label: 'Newest first' },
                  { value: 'oldest', label: 'Oldest first' },
                  { value: 'slowest', label: 'Slowest first' }
                ]}
              />
            </div>
          </div>
          <div
            aria-busy={loading || undefined}
            className="relative flex min-h-0 flex-1 flex-col overscroll-contain"
          >
            <AnimatePresence mode="wait" initial={false}>
              {loading ? (
                // Shaped like the request rows that replace it.
                <motion.div
                  key="loading"
                  role="status"
                  exit={{ opacity: 0, filter: 'blur(4px)' }}
                  transition={{ duration: 0.3, ease }}
                  className="space-y-3 p-4"
                >
                  <span className="sr-only">Loading activity...</span>
                  {Array.from({ length: 5 }, (_, index) => (
                    <div key={index} className="space-y-1.5">
                      <Skeleton className="h-2.5 w-1/3" />
                      <Skeleton className="h-3.5" style={{ width: `${82 - index * 9}%` }} />
                      <Skeleton className="h-2.5 w-1/2" />
                    </div>
                  ))}
                </motion.div>
              ) : !page.rows.length ? (
                <motion.div
                  key="empty"
                  initial={{ opacity: 0, y: 8, filter: 'blur(4px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, y: -8, filter: 'blur(4px)' }}
                  transition={{ duration: 0.35, ease }}
                >
                  <Empty className="p-6 md:py-6">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <ListMagnifyingGlass aria-hidden />
                      </EmptyMedia>
                      <EmptyTitle className="text-[13px] font-normal">No requests</EmptyTitle>
                      <EmptyDescription className="max-w-xs">
                        {search ||
                        modality !== 'all' ||
                        status !== 'all' ||
                        hardware !== 'all' ||
                        slow ||
                        period !== 'all'
                          ? 'No requests match these filters.'
                          : 'No activity yet. Your next AI request will appear here.'}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </motion.div>
              ) : (
                <motion.div
                  key={`rows-${offset}`}
                  className="h-full min-h-0 flex-1"
                  initial={{ opacity: 0, y: 6, filter: 'blur(4px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, y: -6, filter: 'blur(4px)' }}
                  transition={{ duration: 0.3, ease }}
                >
                  <TableVirtuoso
                    className="h-full"
                    aria-label="Requests"
                    data={page.rows}
                    context={{ selectedId, freshIds }}
                    computeItemKey={(_, row) => row.id}
                    components={requestTableComponents}
                    fixedHeaderContent={() => (
                      <tr>
                        {[
                          ['Request', 'text-left'],
                          ['Time', 'w-24 text-right']
                        ].map(([label, align]) => (
                          <th
                            key={label}
                            className={`border-b border-border/60 bg-background/80 px-4 pb-2 pt-2 font-mono text-[10px] font-normal uppercase tracking-[0.18em] text-muted-foreground backdrop-blur-md ${align}`}
                          >
                            {label}
                          </th>
                        ))}
                      </tr>
                    )}
                    itemContent={(_, row, context) => (
                      <>
                        <td className="min-w-0 px-4 py-3 align-top">
                          {context.freshIds.has(row.id) && (
                            <motion.span
                              aria-hidden
                              initial={{ opacity: 1 }}
                              animate={{ opacity: 0 }}
                              transition={{ duration: 1.4, ease }}
                              className="pointer-events-none absolute inset-0 bg-primary/10"
                            />
                          )}
                          {context.selectedId === row.id && (
                            <motion.span
                              aria-hidden
                              layoutId="ai-activity-selection"
                              transition={spring}
                              className="pointer-events-none absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary shadow-[0_0_8px_rgb(var(--og-rgb-primary)/0.8)]"
                            />
                          )}
                          <button
                            type="button"
                            aria-pressed={context.selectedId === row.id}
                            onClick={() => {
                              setRecord(null)
                              setSelectedId(row.id)
                            }}
                            className="group block w-full min-w-0 text-left outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
                          >
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {labels[row.modality]}
                              {row.source ? ` · ${row.source}` : ''}
                              {row.keyName ? ` · ${row.keyName}` : ''}
                              {row.parentId ? ' · Attempt / child' : ''}
                            </span>
                            <span className="my-1 block truncate text-sm transition-transform duration-300 group-hover:translate-x-0.5">
                              <Highlight
                                text={row.preview || row.source}
                                query={debouncedSearch.trim()}
                              />
                            </span>
                            <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                              <span
                                aria-hidden
                                className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[row.status] ?? 'bg-muted-foreground/50'}`}
                              />
                              <span className="truncate">
                                {row.status}
                                {display.model
                                  ? ` · ${row.model ?? row.source} · ${row.backend ?? 'Backend not reported'}`
                                  : ''}
                              </span>
                            </span>
                          </button>
                        </td>
                        <td className="px-4 py-3 text-right align-top font-mono text-[11px] tabular-nums text-muted-foreground">
                          <time className="block">
                            {new Date(row.startedAt).toLocaleTimeString()}
                          </time>
                          {display.details && (
                            <span className="mt-1 block">{duration(row.durationMs)}</span>
                          )}
                        </td>
                      </>
                    )}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-2">
            <IconTip label="Previous">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Previous"
                disabled={offset === 0}
                onClick={() => setOffset((value) => Math.max(0, value - 30))}
              >
                <CaretLeft />
              </Button>
            </IconTip>
            <span className="text-[11px] text-muted-foreground">
              {page.total ? `${offset + 1}-${Math.min(offset + 30, page.total)}` : '0'}
            </span>
            <IconTip label="Next">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Next"
                disabled={offset + 30 >= page.total}
                onClick={() => setOffset((value) => value + 30)}
              >
                <CaretRight />
              </Button>
            </IconTip>
          </div>
        </div>
        <div
          role="region"
          aria-label="Request details"
          className="flex min-h-64 min-w-0 flex-col overflow-hidden md:min-h-0"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-muted/20 px-4 py-3">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Request details
            </span>
            {record && (
              <Segmented
                label="Detail view"
                size="sm"
                tone="quiet"
                value={raw ? 'raw' : 'readable'}
                onValueChange={(view) => setRaw(view === 'raw')}
                options={[
                  { id: 'readable', label: 'Readable' },
                  { id: 'raw', label: 'Raw' }
                ]}
              />
            )}
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-3">
            {record ? (
              <motion.div
                key={record.id}
                initial={{ opacity: 0, y: 6, filter: 'blur(4px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                transition={{ duration: 0.3, ease }}
              >
                <RequestDetail record={record} display={display} raw={raw} />
              </motion.div>
            ) : (
              <Empty className="p-6 md:py-6" aria-busy={selectedId ? true : undefined}>
                <EmptyMedia variant="icon">
                  <ListMagnifyingGlass aria-hidden />
                </EmptyMedia>
                <LiveStatus className="text-sm text-muted-foreground">
                  {selectedId ? 'Loading request...' : 'Select a request to inspect it.'}
                </LiveStatus>
              </Empty>
            )}
          </div>
        </div>
      </div>
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <div className="max-w-xl space-y-1">
          <p className="flex items-center gap-2">
            <HardDrives />
            Local history · Up to {AI_LOG_POLICY.maxAgeDays} days /{' '}
            {AI_LOG_POLICY.maxRecords.toLocaleString()} requests / 256 MB
          </p>
          <Collapsible>
            <CollapsibleTrigger className="w-fit cursor-pointer hover:text-foreground">
              Storage details
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p className="mt-2">
                Large payloads are marked when truncated. Media up to 8 MB is retained. Clearing
                logs does not delete your chats.
              </p>
            </CollapsibleContent>
          </Collapsible>
        </div>
        <IconTip label="Clear history">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear history"
            onClick={() => setConfirmClear(true)}
          >
            <Trash />
          </Button>
        </IconTip>
      </footer>
      <AutoHeight className="shrink-0">
        <AnimatePresence initial={false}>
          {confirmClear && (
            <motion.div
              key="confirm-clear"
              role="group"
              aria-label="Confirm clear activity"
              initial={{ opacity: 0, filter: 'blur(4px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, filter: 'blur(4px)' }}
              transition={{ duration: 0.3, ease }}
              className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3"
            >
              <p className="flex-1 text-sm">Delete all saved AI activity and its media?</p>
              <Button
                size="sm"
                variant="outline"
                disabled={clearing}
                onClick={() => setConfirmClear(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={clearing}
                onClick={() => void clear()}
              >
                <TextMorph as="span">{clearing ? 'Clearing...' : 'Delete history'}</TextMorph>
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </AutoHeight>
    </section>
  )
}

function Filter({
  label,
  value,
  onChange,
  options
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: string[]
}): React.ReactElement {
  const names: Record<string, string> = {
    all: 'Any',
    gpu: 'GPU',
    cpu: 'CPU',
    hour: 'Last hour',
    day: 'Last 24 hours',
    unknown: 'Not reported'
  }
  return (
    <div className="flex min-w-32 flex-col gap-1 text-xs text-muted-foreground">
      <span className="text-[11px] uppercase tracking-wide">{label}</span>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next != null) onChange(next)
        }}
        items={options.map((option) => ({ value: option, label: names[option] ?? option }))}
      >
        <SelectTrigger size="sm" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {names[option] ?? option}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  )
}
