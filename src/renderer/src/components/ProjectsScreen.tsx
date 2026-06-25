import { useEffect, useState, useCallback, type ReactNode } from 'react';
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
} from '@tabler/icons-react';
import { ArtifactCanvas, type Artifact } from './ArtifactCanvas';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (window as any).api;

// Artifacts saved within a project — listed (and openable) from the project view.
function ProjectArtifacts({ projectId }: { projectId: string }): React.ReactElement {
  const [items, setItems] = useState<(Artifact & { id: string; title: string; created: number })[]>([]);
  const [open, setOpen] = useState<Artifact | null>(null);
  useEffect(() => {
    (async () => { try { setItems((await api.listArtifacts?.({ projectId })) || []); } catch { /* ignore */ } })();
  }, [projectId]);
  return (
    <div>
      <div className="mb-3 text-[11px] uppercase tracking-wide text-neutral-500">Artifacts</div>
      {items.length === 0 ? (
        <p className="text-sm text-neutral-600">No artifacts yet — generate HTML, React, SVG, or docs in a chat scoped to this project and they’ll appear here.</p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {items.map((a) => (
            <button key={a.id} onClick={() => setOpen(a)} className="flex items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/60 p-3 text-left transition-colors hover:border-green-500/50">
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-green-400">{a.kind}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">{a.title}</span>
            </button>
          ))}
        </div>
      )}
      {open && <ArtifactCanvas artifact={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

interface Project {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  icon?: string;
  includeMemory: boolean;
  updatedAt: string;
}
interface RagDoc {
  id: number;
  name: string;
  size: number;
  kind: string;
  enabled: boolean;
}
interface RagConvo {
  id: string;
  title: string | null;
  updated_at: string;
  message_count?: number;
}

interface ProjectsScreenProps {
  onOpenChat: (target: { conversationId?: string; projectId?: string }) => void;
}

const KIND_ICON: Record<string, typeof IconFile> = {
  text: IconFileText,
  pdf: IconFile,
  docx: IconFileText,
  image: IconPhoto,
  video: IconMovie,
  audio: IconMicrophone,
};

function fmtSize(n: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function timeAgo(dateStr: string): string {
  const date = new Date(dateStr + 'Z');
  const diffMin = Math.floor((Date.now() - date.getTime()) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function ProjectsScreen({ onOpenChat }: ProjectsScreenProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [view, setView] = useState<'chat' | 'config'>('chat');

  const refreshProjects = useCallback(async () => {
    const list = (await api.listProjects?.()) ?? [];
    setProjects(list);
    setActiveId((cur) => cur ?? list[0]?.id ?? null);
    return list as Project[];
  }, []);

  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  const active = projects.find((p) => p.id === activeId) ?? null;

  const submitNewProject = async (): Promise<void> => {
    const name = newName.trim();
    if (!name) {
      setCreating(false);
      return;
    }
    const id = await api.createProject?.({ name });
    setNewName('');
    setCreating(false);
    await refreshProjects();
    if (id) {
      setActiveId(id);
      setView('config');
    }
  };

  const removeProject = async (id: string): Promise<void> => {
    if (!window.confirm('Delete this project, its knowledge base and chats?')) return;
    await api.deleteProject?.(id);
    setActiveId(null);
    await refreshProjects();
  };

  return (
    <div className="flex h-full font-mono">
      {/* Projects column */}
      <div className="flex w-60 shrink-0 flex-col border-r border-neutral-800">
        <div className="flex items-center justify-between px-4 py-4">
          <h1 className="text-lg font-light tracking-tight text-white">Projects</h1>
          <button
            onClick={() => setCreating(true)}
            title="New project"
            className="rounded-md border border-neutral-800 p-1.5 text-neutral-400 transition-colors hover:border-green-500 hover:text-green-500"
          >
            <IconPlus className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2">
          {creating && (
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitNewProject();
                if (e.key === 'Escape') {
                  setCreating(false);
                  setNewName('');
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
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => setActiveId(p.id)}
              className={`group flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors ${
                p.id === activeId ? 'bg-neutral-900 text-white' : 'text-neutral-400 hover:bg-neutral-900/50'
              }`}
            >
              <IconFolder className="h-4 w-4 shrink-0 text-neutral-500" />
              <span className="truncate">{p.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Active project */}
      {active ? (
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Project header with view toggle */}
          <div className="flex items-center justify-between border-b border-neutral-800 px-6 py-3">
            <div className="flex min-w-0 items-center gap-2 text-sm text-white">
              <IconFolder className="h-4 w-4 shrink-0 text-neutral-500" />
              <span className="truncate">{active.name}</span>
            </div>
            <div className="flex items-center gap-1 rounded-md border border-neutral-800 p-0.5">
              <button
                onClick={() => setView('chat')}
                className={`flex items-center gap-1.5 rounded px-3 py-1 text-xs transition-colors ${
                  view === 'chat' ? 'bg-neutral-800 text-white' : 'text-neutral-500 hover:text-neutral-300'
                }`}
              >
                <IconMessage className="h-3.5 w-3.5" /> Chats
              </button>
              <button
                onClick={() => setView('config')}
                className={`flex items-center gap-1.5 rounded px-3 py-1 text-xs transition-colors ${
                  view === 'config' ? 'bg-neutral-800 text-white' : 'text-neutral-500 hover:text-neutral-300'
                }`}
              >
                <IconSettings className="h-3.5 w-3.5" /> Knowledge & settings
              </button>
            </div>
          </div>

          {view === 'chat' ? (
            <ProjectChats key={active.id} project={active} onOpenChat={onOpenChat} />
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
        <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">
          Select or create a project to get started.
        </div>
      )}
    </div>
  );
}

// --- Project chats (list + open in the main Chat screen) --------------------
// No composer here: chatting always happens in the dedicated Chat screen. This
// just lists the project's conversations and opens them there (scoped).

function ProjectChats({
  project,
  onOpenChat,
}: {
  project: Project;
  onOpenChat: (target: { conversationId?: string; projectId?: string }) => void;
}) {
  const [chats, setChats] = useState<RagConvo[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .getRagConversations?.(project.id)
      .then((c: RagConvo[]) => { if (alive) setChats(c || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [project.id]);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-6">
      <button
        onClick={() => onOpenChat({ projectId: project.id })}
        className="mb-5 flex w-full items-center justify-center gap-2 rounded-md border border-neutral-800 px-3 py-2.5 text-sm text-neutral-300 transition-colors hover:border-green-500 hover:text-green-500"
      >
        <IconPlus className="h-4 w-4" /> New chat
      </button>
      {chats.length === 0 ? (
        <p className="py-10 text-center text-sm text-neutral-600">
          No chats in this project yet. Start one above — it opens in the Chat screen, grounded in this project.
        </p>
      ) : (
        <div className="flex flex-col">
          {chats.map((c) => (
            <button
              key={c.id}
              onClick={() => onOpenChat({ conversationId: c.id })}
              className="group flex items-center gap-3 border-b border-neutral-900 px-2 py-3 text-left transition-colors hover:bg-neutral-900/40"
            >
              <IconMessage className="h-4 w-4 shrink-0 text-neutral-600" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-neutral-200">{c.title || 'Untitled chat'}</div>
                <div className="text-[11px] text-neutral-600">
                  {c.message_count ? `${c.message_count} messages · ` : ''}
                  {timeAgo(c.updated_at)}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Project configuration (details + KB sources + knowledge base) ----------

function ProjectConfig({
  project,
  onSaved,
  onDelete,
}: {
  project: Project;
  onSaved: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [systemPrompt, setSystemPrompt] = useState(project.systemPrompt);
  const [includeMemory, setIncludeMemory] = useState(project.includeMemory);
  const [saving, setSaving] = useState(false);
  // Captured-memory retrieval is a Pro feature — core projects use uploaded docs only.
  const isPro = !!api?.isPro;
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const dirty =
    name !== project.name ||
    description !== project.description ||
    systemPrompt !== project.systemPrompt ||
    includeMemory !== project.includeMemory;

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.updateProject?.(project.id, { name, description, systemPrompt, includeMemory });
      setSavedAt('Saved');
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="flex items-center justify-end gap-3 border-b border-neutral-800 px-6 py-3">
        {savedAt && !dirty && <span className="text-[11px] text-neutral-600">{savedAt}</span>}
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="flex items-center gap-1 rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-white transition-colors hover:border-green-500 hover:text-green-500 disabled:opacity-40"
        >
          {saving ? <IconLoader2 className="h-4 w-4 animate-spin" /> : <IconDeviceFloppy className="h-4 w-4" />} Save
        </button>
        <button onClick={onDelete} title="Delete project" className="rounded-md p-1.5 text-neutral-500 transition-colors hover:text-red-500">
          <IconTrash className="h-4 w-4" />
        </button>
      </div>

      <div className="mx-auto w-full max-w-2xl space-y-6 px-6 py-6">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm text-white outline-none focus:border-green-500"
          />
        </Field>

        <Field label="Description" hint="A short note about what this project is for.">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full resize-none rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm text-white outline-none focus:border-green-500"
          />
        </Field>

        <Field label="System prompt" hint="Instructions prepended to every chat in this project.">
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={5}
            placeholder="You are a helpful assistant for this project…"
            className="w-full resize-none rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm text-white placeholder-neutral-600 outline-none focus:border-green-500"
          />
        </Field>

        {/* Captured-memory retrieval is Pro. Core projects retrieve over uploaded
            documents only — no mention of memory/capture. */}
        {isPro && (
          <Field label="Knowledge sources">
            <button
              onClick={() => setIncludeMemory((v) => !v)}
              className="flex items-center gap-3 text-left"
            >
              <span className={`h-4 w-7 shrink-0 rounded-full transition-colors ${includeMemory ? 'bg-green-500' : 'bg-neutral-700'}`}>
                <span className={`block h-3 w-3 rounded-full bg-white transition-transform ${includeMemory ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
              </span>
              <span className="text-sm text-neutral-300">
                Include captured memory
                <span className="block text-[11px] text-neutral-600">
                  Retrieval spans uploaded documents{includeMemory ? ' + everything Off Grid has captured' : ' only'}.
                </span>
              </span>
            </button>
          </Field>
        )}

        <div className="border-t border-neutral-800 pt-6">
          <KnowledgeBase projectId={project.id} />
        </div>

        <div className="border-t border-neutral-800 pt-6">
          <ProjectArtifacts projectId={project.id} />
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] uppercase tracking-wide text-neutral-500">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-neutral-600">{hint}</div>}
    </div>
  );
}

// --- Knowledge base manager -------------------------------------------------

function KnowledgeBase({ projectId }: { projectId: string }) {
  const [docs, setDocs] = useState<RagDoc[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setDocs((await api.listProjectDocuments?.(projectId)) ?? []);
  }, [projectId]);

  useEffect(() => {
    refresh();
    const off = api.onProjectIndexProgress?.((d: { name: string; stage: string; error?: string }) => {
      if (d.stage === 'error') setStatus(`${d.name}: ${d.error}`);
      else if (d.stage === 'done') {
        setStatus(`${d.name}: indexed`);
        refresh();
      } else setStatus(`${d.name}: ${d.stage}…`);
    });
    return () => off?.();
  }, [refresh]);

  const add = async (): Promise<void> => {
    setBusy(true);
    setStatus('Choose files…');
    try {
      await api.addProjectDocuments?.(projectId);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wide text-neutral-500">Knowledge base</div>
        <button
          onClick={add}
          disabled={busy}
          className="flex shrink-0 items-center gap-1 rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-white transition-colors hover:border-green-500 hover:text-green-500 disabled:opacity-50"
        >
          {busy ? <IconLoader2 className="h-4 w-4 animate-spin" /> : <IconPlus className="h-4 w-4" />} Add files
        </button>
      </div>
      <p className="mb-3 text-[11px] text-neutral-600">
        Documents (txt, md, PDF, DOCX), images, audio, or video. Audio is transcribed; video frames are read by the vision model.
      </p>
      {status && <div className="mb-3 text-[11px] text-neutral-500">{status}</div>}

      <div className="grid grid-cols-1 gap-2">
        {docs.length === 0 && <p className="text-sm text-neutral-600">No documents yet.</p>}
        {docs.map((d) => {
          const Icon = KIND_ICON[d.kind] ?? IconFile;
          return (
            <div key={d.id} className="flex items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/60 p-3">
              <Icon className="h-4 w-4 shrink-0 text-neutral-500" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-white">{d.name}</div>
                <div className="text-[10px] uppercase tracking-wide text-neutral-600">
                  {[d.kind, fmtSize(d.size)].filter(Boolean).join('  ·  ')}
                </div>
              </div>
              <button
                onClick={async () => {
                  await api.toggleProjectDocument?.(d.id, !d.enabled);
                  setDocs((cur) => cur.map((x) => (x.id === d.id ? { ...x, enabled: !x.enabled } : x)));
                }}
                title={d.enabled ? 'Enabled in retrieval' : 'Disabled'}
                className={`h-4 w-7 shrink-0 rounded-full transition-colors ${d.enabled ? 'bg-green-500' : 'bg-neutral-700'}`}
              >
                <span className={`block h-3 w-3 rounded-full bg-white transition-transform ${d.enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
              </button>
              <button
                onClick={async () => {
                  await api.deleteProjectDocument?.(d.id);
                  setDocs((cur) => cur.filter((x) => x.id !== d.id));
                }}
                className="shrink-0 text-neutral-600 transition-colors hover:text-red-500"
              >
                <IconTrash className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
