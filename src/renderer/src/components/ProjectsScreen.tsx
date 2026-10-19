import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'motion/react'
import {
  IconPlus,
  IconFolder,
  IconFile,
  IconFileText,
  IconPhoto,
  IconMovie,
  IconMicrophone,
  IconTrash,
  IconLoader2,
  IconDeviceFloppy,
  IconMessage,
  IconSettings,
  IconLayoutGrid,
  IconX
} from '@tabler/icons-react'
import { Card } from '@offgrid/operator-ui/operator/coss/card'
import { Segmented } from '@offgrid/operator-ui/operator/segmented'
import { TextEffect } from '@offgrid/operator-ui/operator/text-effect'
import {
  Progress,
  ProgressIndicator,
  ProgressTrack
} from '@offgrid/operator-ui/operator/coss/progress'
import { PageHeader } from '@offgrid/operator-ui/operator/experience'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia
} from '@offgrid/operator-ui/operator/coss/empty'
import { Button } from './ui/button'
import { GlyphSwap, IconTip } from './IconTip'
import { ArtifactCanvas, parseArtifact, type Artifact } from './ArtifactCanvas'
import { artifactKindLabel } from '@renderer/lib/artifact-labels'
import { parseSqliteUtc, timeAgo } from '@renderer/lib/time'
import { artifactTitle } from '../../../shared/artifact-title'
import { useRendererEntitlement } from '@renderer/bootstrap/useRendererEntitlement'
import {
  PROJECT_DELETE_FALLBACK_REASON,
  type ProjectDeleteOutcome
} from '../../../shared/project-delete-outcome'
import {
  projectDocumentTransferKey,
  projectDocumentTransferLabel,
  projectDocumentTransferPercent,
  type ProjectDocumentTransfer
} from '../../../shared/project-document-transfer'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (window as any).api

type ProjectArtifact = Artifact & { id: string; title: string; created: number }

/** How many of the project's most recent chats are read for artifacts their replies hold. */
const PROJECT_CHATS_READ = 50

/**
 * The artifacts the project's chats hold, read from their replies. The saved library only has what
 * was made on this device while the chat was already in the project: a chat moved in later, synced
 * from another device or restored brought its artifacts with it, and the tab still said 0.
 */
async function artifactsInProjectChats(projectId: string): Promise<ProjectArtifact[]> {
  const conversations: { id: string }[] =
    (await api.getRagConversations?.(projectId, { limit: PROJECT_CHATS_READ })) ?? []
  const threads = await Promise.all(
    conversations.map(async (conversation) => ({
      conversation,
      messages: ((await api.getRagMessages?.(conversation.id)) ?? []) as {
        id: number
        uuid?: string
        role: string
        content: string
        created_at: string
      }[]
    }))
  )
  return threads.flatMap(({ conversation, messages }) =>
    messages.flatMap((message) => {
      if (message.role !== 'assistant') return []
      const artifact = parseArtifact(message.content)
      if (!artifact || artifact.partial) return []
      return [
        {
          kind: artifact.kind,
          code: artifact.code,
          id: `${conversation.id}:${message.uuid ?? message.id}`,
          title: artifactTitle(artifact.kind, artifact.code),
          created: parseSqliteUtc(message.created_at).getTime()
        }
      ]
    })
  )
}

// Artifacts made within a project — listed (and openable) from the project view.
function ProjectArtifacts({ projectId }: { projectId: string }): React.ReactElement {
  const [items, setItems] = useState<ProjectArtifact[]>([])
  const [open, setOpen] = useState<Artifact | null>(null)
  useEffect(() => {
    const run = { live: true }
    ;(async () => {
      try {
        const [saved, inChats] = await Promise.all([
          api.listArtifacts?.({ projectId }) as Promise<ProjectArtifact[] | undefined>,
          artifactsInProjectChats(projectId)
        ])
        // One entry per artifact: a saved copy and the reply it came from are the same thing.
        const known = new Set((saved ?? []).map((a) => `${a.kind}\n${a.code}`))
        const fresh = inChats.filter((a) => {
          const key = `${a.kind}\n${a.code}`
          if (known.has(key)) return false
          known.add(key)
          return true
        })
        const merged = [...(saved ?? []), ...fresh].sort((a, b) => b.created - a.created)
        if (run.live) setItems(merged)
      } catch {
        /* ignore */
      }
    })()
    return () => {
      run.live = false
    }
  }, [projectId])
  return (
    <div className="w-full px-8 py-6">
      <div className="mb-5 text-[11px] uppercase tracking-widest text-neutral-600">
        {items.length} {items.length === 1 ? 'artifact' : 'artifacts'}
      </div>
      {items.length === 0 ? (
        <p className="py-10 text-center text-sm text-neutral-600">
          Pages, diagrams and documents made in this project&apos;s chats appear here.
        </p>
      ) : (
        <div className="divide-y divide-neutral-800/80 overflow-hidden rounded-lg border border-neutral-800/80 bg-neutral-900/30">
          {items.map((a) => (
            <button
              key={a.id}
              onClick={() => setOpen(a)}
              className="group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-neutral-900/60"
            >
              <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-400">
                {artifactKindLabel(a.kind)}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-neutral-200 group-hover:text-white">
                {a.title}
              </span>
              <span className="shrink-0 text-[10px] text-neutral-600">
                {a.created ? timeAgo(new Date(a.created).toISOString()) : ''}
              </span>
            </button>
          ))}
        </div>
      )}
      <AnimatePresence>
        {open && <ArtifactCanvas artifact={open} onClose={() => setOpen(null)} />}
      </AnimatePresence>
    </div>
  )
}

interface Project {
  id: string
  name: string
  description: string
  systemPrompt: string
  icon?: string
  includeMemory: boolean
  updatedAt: string
}
interface RagDoc {
  id: number
  /** Identity across paired devices; transfers are matched to rows by it. */
  syncId?: string
  name: string
  size: number
  kind: string
  enabled: boolean
  /** Set once the document engine has the file; its state and counts come from that index. */
  documentId?: string
  state?: 'reading' | 'indexing' | 'ready' | 'failed'
  pageCount?: number
  chunkCount?: number
  embeddedCount?: number
  error?: string
}
interface RagConvo {
  id: string
  title: string | null
  updated_at: string
  message_count?: number
}

interface ProjectsScreenProps {
  onOpenChat: (target: { conversationId?: string; projectId?: string }) => void
  selectedProjectId?: string | null
  onSelectProject?: (projectId: string | null) => void
}

const KIND_ICON: Record<string, typeof IconFile> = {
  text: IconFileText,
  pdf: IconFile,
  docx: IconFileText,
  image: IconPhoto,
  video: IconMovie,
  audio: IconMicrophone
}

function fmtSize(n: number): string {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function ProjectsScreen({
  onOpenChat,
  selectedProjectId,
  onSelectProject
}: ProjectsScreenProps): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [localActiveId, setLocalActiveId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [projectQuery, setProjectQuery] = useState('')
  const shownProjects = projectQuery.trim()
    ? projects.filter((p) => p.name.toLowerCase().includes(projectQuery.trim().toLowerCase()))
    : projects
  const [view, setView] = useState<'chat' | 'artifacts' | 'config'>('chat')
  const [deleteFailure, setDeleteFailure] = useState('')

  const refreshProjects = useCallback(async () => {
    const list = (await api.listProjects?.()) ?? []
    setProjects(list)
    setLocalActiveId((cur) => cur ?? list[0]?.id ?? null)
    return list as Project[]
  }, [])

  useEffect(() => {
    void Promise.resolve().then(refreshProjects)
  }, [refreshProjects])

  const activeId = selectedProjectId ?? localActiveId
  const selectProject = (projectId: string | null): void => {
    setLocalActiveId(projectId)
    onSelectProject?.(projectId)
  }
  const active = projects.find((p) => p.id === activeId) ?? null

  const submitNewProject = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) {
      setCreating(false)
      return
    }
    const id = await api.createProject?.({ name })
    setNewName('')
    setCreating(false)
    await refreshProjects()
    if (id) {
      selectProject(id)
      setView('config')
    }
  }

  const removeProject = async (id: string): Promise<void> => {
    if (
      !window.confirm(
        'Delete this project, its knowledge base, and generated artifacts? Its chats stay in Chat.'
      )
    ) {
      return
    }
    setDeleteFailure('')
    const outcome = (await api.deleteProject?.(id)) as ProjectDeleteOutcome | undefined
    if (!outcome?.ok) {
      setDeleteFailure(outcome?.reason || PROJECT_DELETE_FALLBACK_REASON)
      return
    }
    selectProject(null)
    await refreshProjects()
  }

  return (
    <div className="flex h-full font-mono">
      {/* Projects column */}
      <div className="flex w-60 shrink-0 flex-col border-r border-neutral-900">
        <div className="mb-2 flex items-center justify-between border-b border-neutral-900 px-4 py-4">
          <TextEffect
            as="h1"
            preset="fade-in-blur"
            per="char"
            className="text-lg font-light tracking-tight text-white"
          >
            Projects
          </TextEffect>
          <button
            onClick={() => setCreating(true)}
            title="New project"
            className="rounded-md border border-neutral-800 p-1.5 text-neutral-400 transition-colors hover:border-green-500 hover:text-green-500"
          >
            <IconPlus className="h-4 w-4" />
          </button>
        </div>
        {deleteFailure ? (
          <p role="alert" className="mx-4 mb-2 text-[11px] text-red-400">
            {deleteFailure}
          </p>
        ) : null}
        {/* Outside the scrolling list, so finding a project never means scrolling back up. */}
        <div className="px-3 pb-2">
          <input
            value={projectQuery}
            onChange={(e) => setProjectQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setProjectQuery('')
            }}
            aria-label="Find a project"
            placeholder="Find a project"
            className="w-full rounded-md border border-neutral-800 bg-neutral-900/60 px-2.5 py-1.5 text-xs text-white placeholder-neutral-600 outline-none transition-colors focus:border-green-500"
          />
        </div>
        <div className="flex-1 overflow-y-auto px-2">
          {creating && (
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitNewProject()
                if (e.key === 'Escape') {
                  setCreating(false)
                  setNewName('')
                }
              }}
              onBlur={submitNewProject}
              placeholder="Project name…"
              className="mb-2 w-full rounded-md border border-green-500 bg-neutral-900 px-2 py-1.5 text-sm text-white placeholder-neutral-600 outline-none"
            />
          )}
          {projects.length === 0 && !creating && (
            <p className="px-2 py-4 text-xs text-neutral-600">
              No projects yet. Create one to configure a knowledge base.
            </p>
          )}
          <AnimatePresence initial={false}>
            {shownProjects.map((p) => (
              <motion.button
                key={p.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                onClick={() => selectProject(p.id)}
                className={`group flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors ${
                  p.id === activeId
                    ? 'bg-neutral-900 text-white'
                    : 'text-neutral-400 hover:bg-neutral-900/50'
                }`}
              >
                <IconFolder className="h-4 w-4 shrink-0 text-neutral-500" />
                <span className="truncate">{p.name}</span>
              </motion.button>
            ))}
          </AnimatePresence>
        </div>
      </div>

      {/* Active project */}
      {active ? (
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Restart the title reveal when its text changes; new segments otherwise stay hidden. */}
          <PageHeader
            key={active.name}
            className="px-8 pt-8 pb-6"
            eyebrow="Project"
            title={active.name}
            actions={
              <Segmented
                label="Project view"
                size="sm"
                value={view}
                onValueChange={setView}
                options={[
                  {
                    id: 'chat',
                    label: 'Chats',
                    icon: (
                      <>
                        <IconMessage className="h-3.5 w-3.5" /> Chats
                      </>
                    )
                  },
                  {
                    id: 'artifacts',
                    label: 'Artifacts',
                    icon: (
                      <>
                        <IconLayoutGrid className="h-3.5 w-3.5" /> Artifacts
                      </>
                    )
                  },
                  {
                    id: 'config',
                    label: 'Knowledge & settings',
                    icon: (
                      <>
                        <IconSettings className="h-3.5 w-3.5" /> Knowledge & settings
                      </>
                    )
                  }
                ]}
              />
            }
          />

          {view === 'chat' ? (
            <ProjectChats key={active.id} project={active} onOpenChat={onOpenChat} />
          ) : view === 'artifacts' ? (
            <ProjectArtifacts key={active.id} projectId={active.id} />
          ) : (
            <ProjectConfig
              key={active.id}
              project={active}
              onSaved={refreshProjects}
              onDelete={() => removeProject(active.id)}
            />
          )}
        </div>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconFolder />
            </EmptyMedia>
            <EmptyDescription>Select or create a project to get started.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={() => setCreating(true)}>
              <IconPlus className="h-4 w-4" /> New project
            </Button>
          </EmptyContent>
        </Empty>
      )}
    </div>
  )
}

// --- Project chats (list + open in the main Chat screen) --------------------
// No composer here: chatting always happens in the dedicated Chat screen. This
// just lists the project's conversations and opens them there (scoped).

function ProjectChats({
  project,
  onOpenChat
}: {
  project: Project
  onOpenChat: (target: { conversationId?: string; projectId?: string }) => void
}): React.JSX.Element {
  const [chats, setChats] = useState<RagConvo[]>([])

  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void api
        .getRagConversations?.(project.id)
        .then((c: RagConvo[]) => {
          if (alive) setChats(c)
        })
        .catch(() => {})
    }
    refresh()
    const offChanged = api.onRagConversationsChanged?.(() => {
      refresh()
    })
    return () => {
      alive = false
      offChanged?.()
    }
  }, [project.id])

  return (
    <div className="w-full px-8 py-6">
      <div className="mb-5 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-widest text-neutral-600">
          {chats.length} {chats.length === 1 ? 'chat' : 'chats'}
        </span>
        <IconTip label="New chat">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="New chat"
            onClick={() => onOpenChat({ projectId: project.id })}
            className="border-neutral-800 text-neutral-300 hover:border-green-500 hover:text-green-500"
          >
            <IconPlus className="h-4 w-4" />
          </Button>
        </IconTip>
      </div>
      {chats.length === 0 ? (
        <p className="py-10 text-center text-sm text-neutral-600">
          No chats in this project yet. Start one above, and it answers from this project&apos;s
          knowledge.
        </p>
      ) : (
        // A grid uses the width; the title gets two lines and the count sits under it, so a chat
        // reads by its title instead of being cut at two dozen characters.
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {chats.map((c) => (
            <Card
              render={<button />}
              key={c.id}
              onClick={() => onOpenChat({ conversationId: c.id })}
              className="group w-full min-w-0 flex-row items-start gap-2 p-2.5 text-left transition-colors hover:bg-neutral-900/60"
            >
              <IconMessage className="mt-0.5 h-4 w-4 shrink-0 text-neutral-600 group-hover:text-green-500" />
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-sm text-neutral-200">
                  {c.title || 'Untitled chat'}
                </div>
                <div className="mt-0.5 text-[11px] tabular-nums text-neutral-600">
                  {c.message_count ? `${c.message_count} messages · ` : ''}
                  {timeAgo(c.updated_at)}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

// --- Project configuration (details + KB sources + knowledge base) ----------

function ProjectConfig({
  project,
  onSaved,
  onDelete
}: {
  project: Project
  onSaved: () => void
  onDelete: () => void
}): React.JSX.Element {
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const [systemPrompt, setSystemPrompt] = useState(project.systemPrompt)
  const [includeMemory, setIncludeMemory] = useState(project.includeMemory)
  const [saving, setSaving] = useState(false)
  // Captured-memory retrieval is a Pro feature — core projects use uploaded docs only.
  const { isPro } = useRendererEntitlement()
  const [savedAt, setSavedAt] = useState<string | null>(null)

  const dirty =
    name !== project.name ||
    description !== project.description ||
    systemPrompt !== project.systemPrompt ||
    includeMemory !== project.includeMemory

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await api.updateProject?.(project.id, { name, description, systemPrompt, includeMemory })
      setSavedAt('Saved')
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      {/* Landscape: what the project is on the left, what it knows on the right. Save and delete
          sit beside the name instead of on a toolbar row of their own. */}
      <div className="grid w-full gap-x-10 gap-y-8 px-6 py-6 xl:grid-cols-2">
        <div className="min-w-0 space-y-5">
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Field label="Name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm text-white outline-none focus:border-green-500"
                />
              </Field>
            </div>
            <div className="flex shrink-0 items-center gap-2 pb-1">
              {savedAt && !dirty && <span className="text-[11px] text-neutral-600">{savedAt}</span>}
              <IconTip label="Save">
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Save"
                  aria-busy={saving || undefined}
                  onClick={save}
                  disabled={!dirty || saving}
                  className="border-neutral-700 text-white hover:border-green-500 hover:text-green-500 disabled:opacity-40"
                >
                  <GlyphSwap glyphKey={saving ? 'busy' : 'idle'}>
                    {saving ? (
                      <IconLoader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <IconDeviceFloppy className="h-4 w-4" />
                    )}
                  </GlyphSwap>
                </Button>
              </IconTip>
              <IconTip label="Delete project">
                <button
                  onClick={onDelete}
                  title="Delete project"
                  className="rounded-md p-1.5 text-neutral-500 transition-colors hover:text-red-500"
                >
                  <IconTrash className="h-4 w-4" />
                </button>
              </IconTip>
            </div>
          </div>

          <Field label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What this project is for"
              className="w-full resize-none rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm text-white placeholder-neutral-600 outline-none focus:border-green-500"
            />
          </Field>

          <Field label="System prompt">
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={8}
              placeholder="Instructions every chat in this project starts with"
              className="w-full resize-y rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm text-white placeholder-neutral-600 outline-none focus:border-green-500"
            />
          </Field>
        </div>

        <div className="min-w-0 space-y-6">
          {/* Captured-memory retrieval is Pro. Core projects retrieve over uploaded
              documents only, with no mention of memory or capture. */}
          {isPro && (
            <Field label="Knowledge sources">
              <button
                onClick={() => setIncludeMemory((v) => !v)}
                className="flex items-center gap-3 text-left"
              >
                <span
                  className={`h-4 w-7 shrink-0 rounded-full transition-colors ${includeMemory ? 'bg-green-500' : 'bg-neutral-700'}`}
                >
                  <span
                    className={`block h-3 w-3 rounded-full bg-white transition-transform ${includeMemory ? 'translate-x-3.5' : 'translate-x-0.5'}`}
                  />
                </span>
                <span className="text-sm text-neutral-300">
                  Include captured memory
                  <span className="block text-[11px] text-neutral-600">
                    {includeMemory
                      ? 'Answers use your documents and everything captured.'
                      : 'Answers use your documents only.'}
                  </span>
                </span>
              </button>
            </Field>
          )}
          <KnowledgeBase projectId={project.id} />
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1.5 text-[11px] uppercase tracking-wide text-neutral-500">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-neutral-600">{hint}</div>}
    </div>
  )
}

// --- Knowledge base manager -------------------------------------------------

/** A picked file before the document engine has it: being copied, hashed or transcribed. */
interface PendingFile {
  error?: string
}

/** Where a file stands in the document engine. */
interface DocStatus {
  phase: DocumentProgressEvent['phase']
  done: number
  total: number
  error?: string
}

/** The live event speaks while the file works; the stored row speaks when nothing is streaming. */
function docStatus(doc: RagDoc, live: DocumentProgressEvent | undefined): DocStatus | null {
  if (live) return { phase: live.phase, done: live.done, total: live.total, error: live.error }
  if (!doc.state) return null
  if (doc.state === 'indexing') {
    return { phase: 'indexing', done: doc.embeddedCount ?? 0, total: doc.chunkCount ?? 0 }
  }
  return { phase: doc.state, done: 0, total: 0, error: doc.error }
}

const isWorking = (status: DocStatus | null): status is DocStatus =>
  !!status && status.phase !== 'ready' && status.phase !== 'failed'

/** One bar for the whole file, so it never runs back to zero when a new phase starts. */
const PHASE_SPAN: Partial<Record<DocStatus['phase'], [number, number]>> = {
  reading: [0, 30],
  ocr: [30, 50],
  indexing: [50, 100]
}

function statusPercent(status: DocStatus): number {
  const span = PHASE_SPAN[status.phase]
  if (!span) return 100
  const share = status.total ? Math.min(1, status.done / status.total) : 0
  return Math.max(2, Math.round(span[0] + (span[1] - span[0]) * share))
}

function statusLabel(status: DocStatus): string {
  const count = (n: number): string => n.toLocaleString()
  if (status.phase === 'reading') {
    return status.total ? `Reading ${Math.round((100 * status.done) / status.total)}%` : 'Reading…'
  }
  if (status.phase === 'ocr') {
    return status.total ? `Scanning ${count(status.done)}/${count(status.total)}` : 'Scanning…'
  }
  if (status.phase === 'indexing') {
    return status.total ? `Indexing ${count(status.done)} / ${count(status.total)}` : 'Indexing…'
  }
  return status.phase === 'failed' ? "Couldn't read" : ''
}

function readyMeta(doc: RagDoc, pageCount: number | undefined): string {
  const pages =
    pageCount && (doc.kind === 'pdf' || doc.kind === 'docx')
      ? `${pageCount.toLocaleString()} ${pageCount === 1 ? 'page' : 'pages'}`
      : ''
  return [doc.kind, fmtSize(doc.size), pages].filter(Boolean).join('  ·  ')
}

/** Drop live events the stored rows have caught up with, and finished events for other files. */
function pruneLive(
  live: Record<string, DocumentProgressEvent>,
  rows: RagDoc[]
): Record<string, DocumentProgressEvent> {
  const next: Record<string, DocumentProgressEvent> = {}
  for (const [id, event] of Object.entries(live)) {
    const row = rows.find((r) => r.documentId === id)
    const settled = row
      ? row.state === 'ready' || row.state === 'failed'
      : event.phase === 'ready' || event.phase === 'failed'
    if (!settled) next[id] = event
  }
  return next
}

const ROW_TRANSITION: Transition = { duration: 0.32, ease: [0.22, 1, 0.36, 1] }
const NO_TRANSITION: Transition = { duration: 0 }

function PendingRow({
  name,
  file,
  onDismiss
}: {
  name: string
  file: PendingFile
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <div
      className={`flex items-center gap-3 px-3 py-2 transition-colors ${file.error ? 'bg-red-500/5' : ''}`}
    >
      {file.error ? (
        <IconFile className="h-4 w-4 shrink-0 text-red-500" />
      ) : (
        <IconLoader2 className="h-4 w-4 shrink-0 animate-spin text-green-500" />
      )}
      <div
        className={`min-w-0 flex-1 truncate text-sm ${file.error ? 'text-red-400' : 'text-white'}`}
      >
        {name}
      </div>
      <div
        className={`max-w-[50%] shrink-0 truncate text-[10px] uppercase tracking-wide tabular-nums ${file.error ? 'text-red-500' : 'text-neutral-500'}`}
        title={file.error}
      >
        {file.error ?? 'Adding…'}
      </div>
      {file.error ? (
        <IconTip label="Dismiss">
          <button
            onClick={onDismiss}
            aria-label={`Dismiss ${name}`}
            className="shrink-0 text-neutral-600 transition-colors hover:text-white"
          >
            <IconX className="h-4 w-4" />
          </button>
        </IconTip>
      ) : null}
    </div>
  )
}

/** How long a received file's row waits for its document row before it gives way anyway. */
const RECEIVED_ROW_GRACE_MS = 15_000

/** The transfer a document row speaks for: one still moving first, then one that failed. */
function rowTransfer(
  transfers: ProjectDocumentTransfer[],
  syncId: string | undefined
): ProjectDocumentTransfer | undefined {
  if (!syncId) return undefined
  const own = transfers.filter((transfer) => transfer.syncId === syncId)
  return (
    own.find(({ status }) => status === 'active') ?? own.find(({ status }) => status === 'failed')
  )
}

/** A file arriving from a paired device before this device has a row for it. */
function TransferRow({
  transfer,
  transition,
  onDismiss
}: {
  transfer: ProjectDocumentTransfer
  transition: Transition
  onDismiss: () => void
}): React.JSX.Element {
  const failed = transfer.status === 'failed'
  return (
    <div className={`px-3 py-2 transition-colors ${failed ? 'bg-red-500/5' : ''}`}>
      <div className="flex items-center gap-3">
        {failed ? (
          <IconFile className="h-4 w-4 shrink-0 text-red-500" />
        ) : (
          <IconLoader2 className="h-4 w-4 shrink-0 animate-spin text-green-500" />
        )}
        <div
          className={`min-w-0 flex-1 truncate text-sm ${failed ? 'text-red-400' : 'text-white'}`}
        >
          {transfer.fileName}
        </div>
        <div
          className={`max-w-[50%] shrink-0 truncate text-[10px] uppercase tracking-wide tabular-nums transition-colors ${failed ? 'text-red-500' : 'text-neutral-500'}`}
          title={failed ? transfer.error : undefined}
        >
          {projectDocumentTransferLabel(transfer)}
        </div>
        {failed ? (
          <IconTip label="Dismiss">
            <button
              onClick={onDismiss}
              aria-label={`Dismiss ${transfer.fileName}`}
              className="shrink-0 text-neutral-600 transition-colors hover:text-white"
            >
              <IconX className="h-4 w-4" />
            </button>
          </IconTip>
        ) : null}
      </div>
      <AnimatePresence initial={false}>
        {failed ? null : (
          <motion.div
            key="progress"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={transition}
            className="overflow-hidden"
          >
            <Progress
              aria-label={`Receiving ${transfer.fileName}`}
              value={projectDocumentTransferPercent(transfer)}
              className="pt-1.5"
            >
              <ProgressTrack className="h-0.5 rounded-none bg-neutral-800">
                <ProgressIndicator className="bg-green-500 duration-300 ease-out" />
              </ProgressTrack>
            </Progress>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function DocRow({
  doc,
  live,
  transfer,
  transition,
  onToggle,
  onDelete
}: {
  doc: RagDoc
  live: DocumentProgressEvent | undefined
  /** A copy of this file moving to or from a paired device, said after the file's own state. */
  transfer: ProjectDocumentTransfer | undefined
  transition: Transition
  onToggle: () => void
  onDelete: () => void
}): React.JSX.Element {
  const Icon = KIND_ICON[doc.kind] ?? IconFile
  const status = docStatus(doc, live)
  const working = isWorking(status)
  const failed = status?.phase === 'failed'
  const ownState = working || failed
  const syncFailed = !ownState && transfer?.status === 'failed'
  const meta = ownState
    ? statusLabel(status)
    : transfer
      ? projectDocumentTransferLabel(transfer)
      : readyMeta(doc, live?.pageCount || doc.pageCount)
  const metaTitle = failed
    ? status.error || "Couldn't read this file"
    : syncFailed
      ? transfer.error
      : undefined
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-3">
        <Icon
          className={`h-4 w-4 shrink-0 transition-colors ${failed ? 'text-red-500' : 'text-neutral-500'}`}
        />
        <div className="min-w-0 flex-1 truncate text-sm text-white">{doc.name}</div>
        <div
          className={`max-w-[50%] shrink-0 truncate text-[10px] uppercase tracking-wide tabular-nums transition-colors ${failed || syncFailed ? 'text-red-500' : working || transfer ? 'text-neutral-500' : 'text-neutral-600'}`}
          title={metaTitle}
        >
          {meta}
        </div>
        <button
          onClick={onToggle}
          aria-label={`${doc.enabled ? 'Disable' : 'Enable'} ${doc.name}`}
          title={doc.enabled ? 'Enabled in retrieval' : 'Disabled'}
          className={`h-4 w-7 shrink-0 rounded-full transition-colors ${doc.enabled ? 'bg-green-500' : 'bg-neutral-700'}`}
        >
          <span
            className={`block h-3 w-3 rounded-full bg-white transition-transform ${doc.enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`}
          />
        </button>
        <button
          onClick={onDelete}
          aria-label={`Delete ${doc.name}`}
          className="shrink-0 text-neutral-600 transition-colors hover:text-red-500"
        >
          <IconTrash className="h-4 w-4" />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {working ? (
          <motion.div
            key="progress"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={transition}
            className="overflow-hidden"
          >
            <Progress
              aria-label={`Indexing ${doc.name}`}
              value={statusPercent(status)}
              className="pt-1.5"
            >
              <ProgressTrack className="h-0.5 rounded-none bg-neutral-800">
                <ProgressIndicator className="bg-green-500 duration-300 ease-out" />
              </ProgressTrack>
            </Progress>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

function KnowledgeBase({ projectId }: { projectId: string }): React.JSX.Element {
  const reduceMotion = useReducedMotion()
  const [docs, setDocs] = useState<RagDoc[]>([])
  // Live engine progress, by documentId.
  const [live, setLive] = useState<Record<string, DocumentProgressEvent>>({})
  // Picked files the engine does not have yet, by name.
  const [pending, setPending] = useState<Record<string, PendingFile>>({})
  // Files moving to or from paired devices, by transfer key. Empty without sync (free build).
  const [transfers, setTransfers] = useState<Record<string, ProjectDocumentTransfer>>({})
  const [busy, setBusy] = useState(false)
  const refreshSeq = useRef(0)

  const refresh = useCallback(async () => {
    // Progress events refresh often; only the newest answer may land.
    const seq = ++refreshSeq.current
    const rows: RagDoc[] = (await api.listProjectDocuments?.(projectId)) ?? []
    if (seq !== refreshSeq.current) return
    setDocs(rows)
    setLive((cur) => pruneLive(cur, rows))
  }, [projectId])

  useEffect(() => {
    refresh()
    const offAdding = api.onProjectIndexProgress?.(
      (d: {
        projectId: string
        name: string
        stage: 'adding' | 'done' | 'error'
        error?: string
      }) => {
        if (d.projectId !== projectId) return
        if (d.stage === 'done') {
          setPending(({ [d.name]: _added, ...rest }) => rest)
          refresh()
          return
        }
        setPending((cur) => ({
          ...cur,
          [d.name]: d.stage === 'error' ? { error: d.error || "Couldn't add this file" } : {}
        }))
      }
    )
    const offChanged = api.onProjectDocumentsChanged?.(
      ({ projectId: changedProjectId }: { projectId: string }) => {
        if (changedProjectId === projectId) refresh()
      }
    )
    // A project switch must not carry the last project's transfers.
    setTransfers({})
    const snapshot = { current: true }
    void (async () => {
      let known: ProjectDocumentTransfer[] = []
      try {
        known = (await api.listProjectDocumentTransfers?.(projectId)) ?? []
      } catch {
        /* no sync on this build */
      }
      if (!snapshot.current || known.length === 0) return
      // A live event that landed first is newer than the snapshot; keep it.
      setTransfers((cur) => ({
        ...Object.fromEntries(known.map((t) => [projectDocumentTransferKey(t), t])),
        ...cur
      }))
    })()
    const graceTimers = new Set<ReturnType<typeof setTimeout>>()
    const offTransfer = api.onProjectDocumentTransfer?.((transfer: ProjectDocumentTransfer) => {
      if (transfer.projectId !== projectId) return
      const key = projectDocumentTransferKey(transfer)
      const landed = transfer.status === 'completed' && transfer.direction === 'receive'
      if (transfer.status === 'completed' || transfer.status === 'cancelled') {
        // A received file keeps its row at 100% until its document row takes over.
        setTransfers(({ [key]: _done, ...rest }) => (landed ? { ...rest, [key]: transfer } : rest))
        if (landed) {
          refresh()
          const timer = setTimeout(() => {
            graceTimers.delete(timer)
            setTransfers((cur) => {
              if (cur[key]?.status !== 'completed') return cur
              const { [key]: _expired, ...rest } = cur
              return rest
            })
          }, RECEIVED_ROW_GRACE_MS)
          graceTimers.add(timer)
        }
        return
      }
      setTransfers((cur) => ({ ...cur, [key]: transfer }))
    })
    const offProgress = window.api.documents.onProgress((progress) => {
      setLive((cur) => ({ ...cur, [progress.id]: progress }))
      // The row's counts and page total are final now.
      if (progress.phase === 'ready' || progress.phase === 'failed') refresh()
    })
    return () => {
      snapshot.current = false
      for (const timer of graceTimers) clearTimeout(timer)
      offAdding?.()
      offChanged?.()
      offTransfer?.()
      offProgress()
    }
  }, [projectId, refresh])

  const add = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.addProjectDocuments?.(projectId)
    } finally {
      setBusy(false)
      refresh()
    }
  }

  // A file the engine has shows its own row; until then its pending row stands in for it.
  const engineNames = new Set(docs.filter((d) => d.documentId).map((d) => d.name))
  const pendingRows = Object.entries(pending).filter(
    ([name, file]) => file.error || !engineNames.has(name)
  )
  const docRows = docs.filter(
    (d) => d.documentId || !pending[d.name] || Boolean(pending[d.name]?.error)
  )
  // An arriving file has its own row until this device lists it; then its document row speaks.
  const transferList = Object.values(transfers)
  const docSyncIds = new Set(docs.map((d) => d.syncId).filter(Boolean))
  const arrivingRows = transferList.filter(
    (t) => t.direction === 'receive' && !docSyncIds.has(t.syncId)
  )
  const dismissTransfer = (transfer: ProjectDocumentTransfer): void => {
    const key = projectDocumentTransferKey(transfer)
    setTransfers(({ [key]: _dismissed, ...rest }) => rest)
    api.dismissProjectDocumentTransfer?.(key).catch(() => undefined)
  }
  const rowTransition = reduceMotion ? NO_TRANSITION : ROW_TRANSITION
  const rowMotion = {
    initial: { opacity: 0, height: 0 },
    animate: { opacity: 1, height: 'auto' },
    exit: { opacity: 0, height: 0 },
    transition: rowTransition,
    className: 'overflow-hidden'
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wide text-neutral-500">Knowledge base</div>
        <IconTip label="Add files">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Add files"
            aria-busy={busy || undefined}
            onClick={add}
            disabled={busy}
            className="shrink-0 border-neutral-700 text-white hover:border-green-500 hover:text-green-500 disabled:opacity-50"
          >
            <GlyphSwap glyphKey={busy ? 'busy' : 'idle'}>
              {busy ? (
                <IconLoader2 className="h-4 w-4 animate-spin" />
              ) : (
                <IconPlus className="h-4 w-4" />
              )}
            </GlyphSwap>
          </Button>
        </IconTip>
      </div>
      <p className="mb-3 text-[11px] text-neutral-600">
        Documents, images, audio and video. Audio is transcribed; video is read frame by frame.
      </p>
      {docRows.length === 0 && pendingRows.length === 0 && arrivingRows.length === 0 && (
        <p className="text-sm text-neutral-600">No documents yet.</p>
      )}
      <div className="divide-y divide-neutral-800 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900/60 empty:hidden">
        <AnimatePresence initial={false}>
          {pendingRows.map(([name, file]) => (
            <motion.div key={`pending:${name}`} {...rowMotion}>
              <PendingRow
                name={name}
                file={file}
                onDismiss={() => setPending(({ [name]: _dismissed, ...rest }) => rest)}
              />
            </motion.div>
          ))}
          {arrivingRows.map((transfer) => (
            <motion.div key={`transfer:${projectDocumentTransferKey(transfer)}`} {...rowMotion}>
              <TransferRow
                transfer={transfer}
                transition={rowTransition}
                onDismiss={() => dismissTransfer(transfer)}
              />
            </motion.div>
          ))}
          {docRows.map((d) => (
            <motion.div key={d.id} {...rowMotion}>
              <DocRow
                doc={d}
                live={d.documentId ? live[d.documentId] : undefined}
                transfer={rowTransfer(transferList, d.syncId)}
                transition={rowTransition}
                onToggle={async () => {
                  await api.toggleProjectDocument?.(d.id, !d.enabled)
                  setDocs((cur) =>
                    cur.map((x) => (x.id === d.id ? { ...x, enabled: !x.enabled } : x))
                  )
                }}
                onDelete={async () => {
                  await api.deleteProjectDocument?.(d.id)
                  setDocs((cur) => cur.filter((x) => x.id !== d.id))
                }}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}
