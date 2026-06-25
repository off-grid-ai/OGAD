import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown, { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { ArtifactCanvas, parseArtifact, type Artifact } from './ArtifactCanvas';
import { VoiceBubble, stopAllVoicePlayback } from './VoiceBubble';
import { SkillsPanel } from './SkillsPanel';
import { SettingsPanel } from './SettingsPanel';
import { ModelPicker } from './ModelPicker';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@renderer/components/ui/dropdown-menu';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/components/ui/collapsible';
import { Plus, Paperclip, Image as ImageIcon, Sparkle as Sparkles, FolderPlus, Wrench, MagnifyingGlass as Search, Plug, SlidersHorizontal, Brain, FolderOpen, CaretDown, Lightning } from '@phosphor-icons/react';

type RagContext = {
  masterMemory?: string | null;
  memories?: any[];
  messages?: any[];
  summaries?: any[];
  entities?: any[];
  entityFacts?: any[];
  unified?: { kind: string; title: string; snippet: string; surface: string; ts: number; refId?: number; imagePath?: string | null }[];
  image?: string;
  sources?: { name: string; position: number; score: number }[];
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  context?: RagContext;
  image?: string;
  imagePath?: string;
  toolCalls?: { name: string; result: string }[];
  reasoning?: string;
  streaming?: boolean;
  activity?: { kind: string; counts?: Record<string, number> };
  attachments?: { name: string; kind: string; text?: string; path?: string }[];
  variants?: string[];      // regenerated answers (navigate with ‹ ›)
  variantIndex?: number;
  audioUrl?: string;        // voice-mode: recorded clip for a user voice note
  audioDuration?: number;   // seconds, when known from the recording
};

type ChatMode = 'ask' | 'image';

type AskBlock = { question: string; options: string[]; multiSelect: boolean };

// Detect a model-emitted interactive question: ```ask { question, options, multiSelect }```
function parseAsk(content: string): AskBlock | null {
  const m = content.match(/```ask\s*\n([\s\S]*?)```/i);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1].trim());
    if (j && typeof j.question === 'string' && Array.isArray(j.options) && j.options.length) {
      return { question: j.question, options: j.options.map(String), multiSelect: !!j.multiSelect };
    }
  } catch { /* not a valid ask block */ }
  return null;
}

const ASK_FENCE = /```ask\s*\n[\s\S]*?```/i;
// Artifact code (html/svg/mermaid/react/image) is rendered on the side canvas, not
// dumped inline — strip the fenced block from the chat bubble and show a card instead.
const ARTIFACT_FENCE = /```(?:html|svg|mermaid|jsx|tsx|react|image)\s*\n[\s\S]*?```/gi;

// Human label for a live retrieval/activity step shown while the model works.
function activityLabel(a?: { kind: string; counts?: Record<string, number> }): string {
  if (!a) return '';
  if (a.kind === 'reading') return `Reading the page${(a.counts?.urls ?? 0) > 1 ? 's' : ''}…`;
  if (a.kind === 'searching') return 'Searching your memory…';
  if (a.kind === 'memory') {
    const c = a.counts || {};
    const total = (c.memories || 0) + (c.summaries || 0) + (c.entities || 0) + (c.facts || 0) + (c.unified || 0);
    return `Searched your memory — ${total} result${total === 1 ? '' : 's'}`;
  }
  if (a.kind === 'project') {
    const c = a.counts || {};
    return `Searched project — ${c.sources || 0} sources · ${c.projectChats || 0} chats`;
  }
  return 'Working…';
}

type Attachment = {
  id: string;
  name: string;
  kind: 'text' | 'pdf' | 'docx' | 'image' | 'audio' | 'video' | 'pasted';
  text: string;
  path?: string; // images: persisted path passed to the vision model
  preview?: string; // images: a local object URL shown immediately while processing
  status: 'loading' | 'ready' | 'error';
};

type Conversation = {
  id: string;
  title: string | null;
  project_id?: string | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
};

type ProjectLite = { id: string; name: string };

interface MemoryChatProps {
  onNavigateToMemory?: (memoryId: number) => void;
  onNavigateToChat?: (sessionId: string) => void;
  onNavigateToEntity?: (entityId: number) => void;
  /** Open a specific conversation, or start a new one scoped to a project. */
  openTarget?: { conversationId?: string; projectId?: string } | null;
  onTargetConsumed?: () => void;
}

function mapRagMessages(raw: any[]): ChatMessage[] {
  return (raw || []).map((m: any) => {
    const ctx = m.context ? (typeof m.context === 'string' ? JSON.parse(m.context) : m.context) : undefined;
    return {
      id: String(m.id),
      role: m.role as 'user' | 'assistant',
      content: m.content,
      context: ctx,
      image: ctx?.image ? `ogcapture://${ctx.image}` : undefined,
      imagePath: ctx?.image,
      // Attachments persisted on the user turn (clickable chips survive reload).
      attachments: Array.isArray(ctx?.attachments) ? ctx.attachments : undefined,
    };
  });
}

const ASK_EXAMPLES = [
  'What did I work on today?',
  'Summarize my last meeting',
  'What have I spent the most time on this week?',
  'What open action items do I have?',
];
const IMAGE_EXAMPLES = [
  'A serene mountain lake at dawn, photorealistic',
  'Minimal logo mark for a coffee brand, flat',
  'Cyberpunk city street at night, neon, rain',
  'Studio portrait of a husky, soft lighting',
];

// Gemini-style visual style presets — pick one, then describe the subject; the
// style text is appended to the prompt. `swatch` = a characteristic gradient so
// the gallery is pictorial (no bundled images needed).
// `prompt` = style modifier appended to the user's subject when generating.
// `preview` = the subject used for the on-device style-thumbnail (varied per
// style so the grid showcases the style, not a gallery of faces).
const STYLE_PRESETS: { name: string; prompt: string; preview: string; swatch: string }[] = [
  { name: 'Photoreal', prompt: 'photorealistic, sharp focus, high detail, 50mm photo', preview: 'a red fox standing in a misty forest', swatch: 'from-stone-400 to-stone-600' },
  { name: 'Cinematic', prompt: 'cinematic film still, dramatic lighting, shallow depth of field, color graded', preview: 'a lone car on a coastal highway at sunset', swatch: 'from-orange-800 via-neutral-800 to-teal-800' },
  { name: 'Anime', prompt: 'anime illustration, clean lineart, vibrant colors', preview: 'a bustling futuristic city street with cherry blossoms', swatch: 'from-pink-400 via-purple-400 to-sky-400' },
  { name: 'Sketch', prompt: 'detailed pencil sketch on paper, monochrome line art', preview: 'an old european cathedral', swatch: 'from-neutral-300 to-neutral-500' },
  { name: 'Watercolor', prompt: 'watercolor painting, soft washes, paper texture', preview: 'a serene mountain lake with pine trees', swatch: 'from-rose-300 via-sky-200 to-emerald-300' },
  { name: 'Oil painting', prompt: 'oil painting, visible brushstrokes, classical, rich color', preview: 'a still life of fruit and a wine bottle on a table', swatch: 'from-amber-700 via-red-800 to-yellow-700' },
  { name: 'Monochrome', prompt: 'black and white, high contrast, monochrome', preview: 'a rainy city street with umbrellas', swatch: 'from-neutral-900 to-neutral-500' },
  { name: 'Neon', prompt: 'neon-lit cyberpunk, glowing lights, night, moody', preview: 'a rain-soaked alley in a cyberpunk city', swatch: 'from-fuchsia-600 via-purple-700 to-cyan-500' },
  { name: '3D render', prompt: '3D render, octane, soft studio lighting, subsurface detail', preview: 'a cute friendly robot character', swatch: 'from-slate-300 via-slate-500 to-slate-700' },
  { name: 'Steampunk', prompt: 'steampunk, brass and gears, victorian, intricate', preview: 'a flying steampunk airship above the clouds', swatch: 'from-amber-800 via-yellow-900 to-stone-700' },
  { name: 'Surreal', prompt: 'surreal, dreamlike, imaginative composition', preview: 'floating islands with waterfalls in a dreamlike sky', swatch: 'from-indigo-500 via-fuchsia-500 to-amber-400' },
  { name: 'Vintage film', prompt: 'vintage film photograph, faded colors, grain, 1970s', preview: 'a vintage convertible car on a desert road', swatch: 'from-amber-300 via-orange-300 to-rose-300' },
  { name: 'Minimal', prompt: 'minimal flat design, clean, simple shapes, lots of negative space', preview: 'a single sailboat on calm water', swatch: 'from-neutral-100 to-neutral-300' },
  { name: 'Risograph', prompt: 'risograph print, halftone texture, limited palette', preview: 'a bicycle leaning against a wall', swatch: 'from-pink-500 via-yellow-400 to-blue-500' },
  { name: 'Fantasy art', prompt: 'epic fantasy concept art, dramatic, highly detailed', preview: 'a majestic dragon perched on a mountain peak', swatch: 'from-purple-800 via-indigo-700 to-amber-600' },
  { name: 'Studio portrait', prompt: 'studio portrait, soft key light, bokeh background', preview: 'a golden retriever dog', swatch: 'from-neutral-600 via-neutral-800 to-neutral-900' },
];

function timeAgo(dateStr: string): string {
  const date = new Date(dateStr + 'Z');
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function MemoryChat({ onNavigateToMemory, onNavigateToChat, onNavigateToEntity, openTarget, onTargetConsumed }: MemoryChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([]);
  const [askSel, setAskSel] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);
  const [generatingConvId, setGeneratingConvId] = useState<string | null>(null); // which tab is generating
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convSearch, setConvSearch] = useState('');
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  // Voice playback must never carry across chats — stop it whenever the active
  // conversation changes (and on unmount).
  useEffect(() => { stopAllVoicePlayback(); return () => stopAllVoicePlayback(); }, [activeConversationId]);
  const [openTabs, setOpenTabs] = useState<string[]>([]); // conversation ids open as tabs
  const [showHistory, setShowHistory] = useState(true);
  const [mode, setMode] = useState<ChatMode>('ask');
  const [showImageOptions, setShowImageOptions] = useState(false);
  const [imageAvailable, setImageAvailable] = useState(false);
  const [imgSize, setImgSize] = useState(512);
  const [imgSteps, setImgSteps] = useState(16);
  const [imgSeed, setImgSeed] = useState('');
  const [imgNegative, setImgNegative] = useState('');
  const [imgInit, setImgInit] = useState<string | null>(null);
  const [imgStrength, setImgStrength] = useState(0.6);
  const [imgModels, setImgModels] = useState<string[]>([]);
  const [imgModel, setImgModel] = useState<string>('');
  const [activeStyle, setActiveStyle] = useState<string | null>(null);
  const [styleThumbs, setStyleThumbs] = useState<Record<string, string>>({});
  const [genThumbsBusy, setGenThumbsBusy] = useState(false);
  const [imgProgress, setImgProgress] = useState<{ step: number; total: number; secPerStep: number; preview?: string; phase?: 'sampling' | 'decoding' } | null>(null);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  // Captured-memory context is a Pro ("remembers") feature; core chats are plain
  // (no memory) or scoped to a project. The UI never says "memory".
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isPro = !!(window as any).api?.isPro;
  const [noMemory, setNoMemory] = useState(!isPro);
  const [, setProjectMenuOpen] = useState(false);
  const [projCreating, setProjCreating] = useState(false);
  const [projNewName, setProjNewName] = useState('');
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [toolsOn, setToolsOn] = useState(false);
  const [connectorsOn, setConnectorsOn] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false); // voice mode: messages exchanged as voice notes
  useEffect(() => { if (!voiceMode) stopAllVoicePlayback(); }, [voiceMode]);

  // Composer preferences persist across sessions (memory scope, thinking, tools,
  // voice mode). Individual tool toggles and model choices persist on their own
  // (DB `disabledTools`, active-model.json). Load once, then save on every change.
  const prefsLoaded = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const s = await window.api.getSettings();
        if (s) {
          if (typeof s.composerNoMemory === 'boolean') setNoMemory(s.composerNoMemory);
          if (typeof s.composerToolsOn === 'boolean') setToolsOn(s.composerToolsOn);
          if (typeof s.composerConnectorsOn === 'boolean') setConnectorsOn(s.composerConnectorsOn);
          if (typeof s.composerThinking === 'boolean') setThinkingEnabled(s.composerThinking);
          if (typeof s.composerVoiceMode === 'boolean') setVoiceMode(s.composerVoiceMode);
        }
      } catch (e) { console.error('Failed to load composer prefs', e); }
      finally { prefsLoaded.current = true; }
    })();
  }, []);
  useEffect(() => { if (prefsLoaded.current) void window.api.saveSetting('composerNoMemory', noMemory); }, [noMemory]);
  useEffect(() => { if (prefsLoaded.current) void window.api.saveSetting('composerToolsOn', toolsOn); }, [toolsOn]);
  useEffect(() => { if (prefsLoaded.current) void window.api.saveSetting('composerConnectorsOn', connectorsOn); }, [connectorsOn]);
  useEffect(() => { if (prefsLoaded.current) void window.api.saveSetting('composerThinking', thinkingEnabled); }, [thinkingEnabled]);
  useEffect(() => { if (prefsLoaded.current) void window.api.saveSetting('composerVoiceMode', voiceMode); }, [voiceMode]);
  const [autoPlayId, setAutoPlayId] = useState<string | null>(null); // assistant reply to auto-speak once
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [speakLoadingId, setSpeakLoadingId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [canvasWidth, setCanvasWidth] = useState<number | null>(null); // px; null = default 30vw
  const [dragOver, setDragOver] = useState(false);
  const [viewer, setViewer] = useState<{ title: string; text: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [lightbox, setLightbox] = useState<{ url: string; path?: string } | null>(null);
  const [canvasArtifact, setCanvasArtifact] = useState<Artifact | null>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [showGallery, setShowGallery] = useState(false);
  // The canvas / text viewer / gallery belong to a specific message, so they must
  // not bleed across chats — close them whenever the active conversation changes
  // (switch tab, new chat, close-to-fallback, open-from-projects, delete).
  useEffect(() => { setCanvasArtifact(null); setViewer(null); setShowGallery(false); }, [activeConversationId]);
  const [gallery, setGallery] = useState<{ path: string; name: string; mtime: number }[]>([]);
  const [galleryTab, setGalleryTab] = useState<'images' | 'artifacts'>('images');
  const [galleryScope, setGalleryScope] = useState<'chat' | 'project' | 'all'>('all');
  const [artifacts, setArtifacts] = useState<(Artifact & { id: string; title: string; created: number })[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingVariantsRef = useRef<string[] | null>(null); // prior answers to keep when regenerating
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sendingRef = useRef(false);
  // Queued sends carry their attachments too, so a message waiting behind an
  // in-flight generation keeps its image/files when it finally runs.
  const queueRef = useRef<{ text: string; atts: Attachment[] }[]>([]);
  const [queued, setQueued] = useState<{ text: string; atts: Attachment[] }[]>([]);

  const markdownComponents: Components = {
    p: ({ children }) => <p style={{ margin: 0 }}>{children}</p>,
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noreferrer" className="text-green-500 underline">
        {children}
      </a>
    ),
    code: ({ children, ...props }) => {
      const inline = !('className' in props);
      return (
        <code className={`font-mono text-[0.9em] bg-neutral-800/60 rounded ${inline ? 'px-1 py-0.5' : 'block px-2.5 py-2 overflow-x-auto'}`}>
          {children}
        </code>
      );
    },
    pre: ({ children }) => <pre style={{ margin: 0 }}>{children}</pre>,
  };

  // Citation-aware markdown components: `[S2]` in an answer is rewritten to a
  // cite: link and rendered as a clickable chip that opens the exact source it
  // cites (memory / entity / meeting). Falls back to a normal link otherwise.
  const makeCiteComponents = (unified?: RagContext['unified']): Components => ({
    ...markdownComponents,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    a: ({ href, children }: any) => {
      const m = typeof href === 'string' ? /^cite:(\d+)$/.exec(href) : null;
      if (m && unified) {
        const u = unified[parseInt(m[1], 10) - 1];
        return (
          <button
            type="button"
            onClick={() => {
              if (!u || u.refId == null) return;
              if (u.kind === 'memory') onNavigateToMemory?.(u.refId);
              else if (u.kind === 'entity') onNavigateToEntity?.(u.refId);
              else if (u.kind === 'meeting') onNavigateToChat?.(String(u.refId));
            }}
            title={u ? `${u.kind} · ${u.surface}${u.title ? ' · ' + u.title : ''}` : 'source'}
            className="mx-0.5 inline-flex items-center rounded-sm border border-green-500/40 bg-green-500/10 px-1 align-baseline text-[0.72em] font-semibold text-green-500 transition-colors hover:bg-green-500/20"
          >
            {children}
          </button>
        );
      }
      return <a href={href} target="_blank" rel="noreferrer" className="text-green-500 underline">{children}</a>;
    },
  } as Components);

  // Load conversations on mount; probe image gen; load projects for scoping.
  useEffect(() => {
    loadConversations();
    window.api.imageGenStatus?.().then((s: { available: boolean; models?: string[] }) => {
      setImageAvailable(!!s?.available);
      const models = s?.models || [];
      setImgModels(models);
      // Default to the best fit: Z-Image Turbo (2026 flagship) > SDXL-Lightning > SDXL > 2.1 > rest.
      const preferred = models.find(m => /z[-_]?image/i.test(m)) || models.find(m => /lightning/i.test(m)) || models.find(m => /sdxl|xl/i.test(m)) || models.find(m => /v2-1|v2\.1/i.test(m)) || models[0] || '';
      setImgModel(prev => prev || preferred);
    }).catch(() => {});
    window.api.listProjects?.().then((p: ProjectLite[]) => setProjects(p || [])).catch(() => {});
    window.api.styleThumbs?.().then((t: Record<string, string>) => setStyleThumbs(t || {})).catch(() => {});
  }, []);

  const styleKey = (name: string): string => name.replace(/[^\w-]+/g, '_');

  // Generate on-device preview thumbnails for any styles that don't have one yet.
  const generateStylePreviews = useCallback(async () => {
    if (genThumbsBusy) return;
    setGenThumbsBusy(true);
    try {
      for (const s of STYLE_PRESETS) {
        const k = styleKey(s.name);
        if (styleThumbs[k]) continue;
        try {
          await window.api.makeStyleThumb?.(s.name, `${s.preview}, ${s.prompt}`);
          const refreshed = await window.api.styleThumbs?.();
          if (refreshed) setStyleThumbs(refreshed);
        } catch (e) { console.error('style thumb failed', s.name, e); }
      }
    } finally {
      setGenThumbsBusy(false);
    }
  }, [genThumbsBusy, styleThumbs]);

  // Match canvas + steps to the model. Few-step models (Lightning/Turbo) need
  // very low steps; full models want their native resolution.
  useEffect(() => {
    if (!imgModel) return;
    const zimage = /z[-_]?image/i.test(imgModel);
    const lightning = /lightning/i.test(imgModel);
    const turbo = /turbo/i.test(imgModel) && !zimage;
    setImgSize(turbo ? 512 : /sdxl|xl/i.test(imgModel) || lightning || zimage ? 1024 : /v2-1|v2\.1/i.test(imgModel) ? 768 : 512);
    if (zimage) setImgSteps(8);
    else if (turbo) setImgSteps(4);
    else if (lightning) setImgSteps(parseInt(imgModel.match(/(\d+)\s*step/i)?.[1] || '4', 10));
    else setImgSteps(/sdxl|xl/i.test(imgModel) ? 28 : 20);
  }, [imgModel]);

  const activeProjectName = projects.find(p => p.id === activeProjectId)?.name ?? null;

  const loadProjects = useCallback(async () => {
    try { setProjects((await window.api.listProjects?.()) || []); } catch (e) { console.error(e); }
  }, []);

  // Assign the current chat to a project (or clear it). Persists if a conversation exists.
  const assignProject = useCallback(async (projectId: string | null) => {
    setNoMemory(false); // choosing All-memory or a project turns memory on
    setActiveProjectId(projectId);
    setProjectMenuOpen(false);
    setProjCreating(false);
    setProjNewName('');
    if (activeConversationId) {
      try { await window.api.setRagConversationProject?.(activeConversationId, projectId); } catch (e) { console.error(e); }
      await loadConversations();
    }
  }, [activeConversationId]);

  // Create a project inline and assign the current chat to it.
  const createAndAssignProject = useCallback(async () => {
    const name = projNewName.trim();
    if (!name) { setProjCreating(false); return; }
    try {
      const id = await window.api.createProject?.({ name });
      await loadProjects();
      if (id) await assignProject(id);
    } catch (e) { console.error('Failed to create project', e); }
  }, [projNewName, loadProjects, assignProject]);

  useEffect(() => {
    // Only follow the stream if the user is already near the bottom — don't yank
    // them down when they've scrolled up to read while generating.
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 120) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Live per-step image generation progress (step counter + forming preview).
  useEffect(() => {
    const off = window.api.onImageGenProgress?.((p) => setImgProgress(p));
    return () => off?.();
  }, []);

  const loadConversations = async () => {
    try {
      const convos = await window.api.getRagConversations();
      setConversations(convos || []);
    } catch (e) {
      console.error('Failed to load conversations:', e);
    }
  };

  const switchConversation = useCallback(async (convId: string) => {
    setOpenTabs(t => (t.includes(convId) ? t : [...t, convId]));
    if (convId === activeConversationId) return;
    setActiveConversationId(convId);
    setActiveProjectId(conversations.find(c => c.id === convId)?.project_id ?? null);
    try {
      const rawMessages = await window.api.getRagMessages(convId);
      setMessages(mapRagMessages(rawMessages));
    } catch (e) {
      console.error('Failed to load messages:', e);
      setMessages([]);
    }
  }, [activeConversationId, conversations]);

  // Close a chat tab; fall back to another open tab (or a fresh chat) if it was active.
  const closeTab = useCallback((convId: string) => {
    setOpenTabs(prev => {
      const next = prev.filter(t => t !== convId);
      if (activeConversationId === convId) {
        const fallback = next[next.length - 1];
        if (fallback) void switchConversation(fallback);
        else { setActiveConversationId(null); setMessages([]); setActiveProjectId(null); }
      }
      return next;
    });
  }, [activeConversationId, switchConversation]);

  // Open a target passed from the Projects tab (an existing chat, or a new chat
  // scoped to a project). Resolves project from the DB to avoid stale state.
  useEffect(() => {
    if (!openTarget) return;
    (async () => {
      try {
        if (openTarget.conversationId) {
          const convId = openTarget.conversationId;
          setActiveConversationId(convId);
          setOpenTabs(t => (t.includes(convId) ? t : [...t, convId]));
          const conv = await window.api.getRagConversation?.(convId);
          setActiveProjectId((conv as { project_id?: string | null })?.project_id ?? null);
          setMessages(mapRagMessages(await window.api.getRagMessages(convId)));
        } else if (openTarget.projectId) {
          setActiveConversationId(null);
          setMessages([]);
          setActiveProjectId(openTarget.projectId);
        }
        await loadConversations();
      } catch (e) {
        console.error('Failed to open chat target:', e);
      } finally {
        onTargetConsumed?.();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTarget]);

  const startNewConversation = useCallback(() => {
    setActiveConversationId(null);
    setMessages([]);
    setActiveProjectId(null);
  }, []);

  const deleteConversation = useCallback(async (convId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await window.api.deleteRagConversation(convId);
      if (activeConversationId === convId) {
        setActiveConversationId(null);
        setMessages([]);
      }
      await loadConversations();
    } catch (err) {
      console.error('Failed to delete conversation:', err);
    }
  }, [activeConversationId]);

  const sendMessage = async (override?: string, opts?: { regen?: boolean; voiceClip?: { url: string; duration: number }; atts?: Attachment[] }) => {
    const isInput = override === undefined;
    // Regenerate/Resend: the user turn already exists in the thread — re-run it
    // in place instead of echoing another user bubble.
    const regen = opts?.regen ?? false;
    // Attachments (pasted blocks + processed files) ride along on a normal send
    // from the composer, or on a drained queue item (opts.atts) — not on
    // resend/regenerate/example.
    const atts = opts?.atts ?? (isInput ? attachments.filter(a => a.status === 'ready' && (a.text || a.path)) : []);
    const typed = (override ?? input).trim();
    // The user sees `trimmed`; the model also gets the attachment text folded in.
    const trimmed = typed || (atts.length ? `(${atts.length} attachment${atts.length > 1 ? 's' : ''})` : '');
    const attBlock = atts.filter(a => a.text).map(a => `--- attached ${a.kind}: ${a.name} ---\n${a.text}`).join('\n\n');
    // Actual image files go to the multimodal model (not just their captions).
    const imagePaths = atts.filter(a => a.kind === 'image' && a.path).map(a => a.path as string);
    let modelQuery = (attBlock ? `${attBlock}\n\n${typed}` : typed).trim();
    if (!typed && atts.length === 0) return;
    // Don't block the user — if a generation is in flight, queue this message and
    // let them keep typing/sending. The queue drains in order when each finishes.
    if (sendingRef.current) {
      const item = { text: typed, atts };
      queueRef.current.push(item);
      setQueued(q => [...q, item]);
      if (isInput) { setInput(''); setAttachments([]); }
      return;
    }
    sendingRef.current = true;
    if (isInput) setAttachments([]);

    // Skill invocation: "/skill-name [rest]" prepends that skill's instructions.
    if (isInput) {
      const sm = /^\/([A-Za-z0-9_-]+)\s*([\s\S]*)$/.exec(typed);
      if (sm && skills.some(s => s.name.toLowerCase() === sm[1].toLowerCase())) {
        try {
          const sk = await window.api.getSkill?.(sm[1]);
          if (sk) {
            const rest = sm[2].trim();
            modelQuery = `${attBlock ? attBlock + '\n\n' : ''}# Skill: ${sk.name}\n${sk.instructions}\n\n${rest}`.trim();
          }
        } catch (e) { console.error('skill load failed', e); }
      }
    }

    let convId = activeConversationId;

    // Create new conversation if none active
    if (!convId) {
      convId = `rag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const title = trimmed.length > 50 ? trimmed.slice(0, 47) + '...' : trimmed;
      try {
        await window.api.createRagConversation(convId, title, activeProjectId);
        setActiveConversationId(convId);
        setOpenTabs(t => (t.includes(convId!) ? t : [...t, convId!]));
      } catch (e) {
        console.error('Failed to create conversation:', e);
        sendingRef.current = false;
        return;
      }
    }

    if (!regen) {
      const userMessage: ChatMessage = { id: `u-${Date.now()}`, role: 'user', content: trimmed, attachments: atts.map(a => ({ name: a.name, kind: a.kind, text: a.text, path: a.path })), audioUrl: opts?.voiceClip?.url, audioDuration: opts?.voiceClip?.duration };
      setMessages(prev => [...prev, userMessage]);
    }
    setInput('');
    setLoading(true);
    setGeneratingConvId(convId); // so the thinking indicator only shows in this tab

    // Persist user message (skip on regen — it's already in the thread). Stash
    // the attachments in the message context so the clickable chips survive reload.
    try {
      if (!regen) {
        const attMeta = atts.map(a => ({ name: a.name, kind: a.kind, text: a.text, path: a.path }));
        await window.api.addRagMessage(convId, 'user', trimmed, attMeta.length ? { attachments: attMeta } : undefined);
      }
    } catch (e) {
      console.error('Failed to persist user message:', e);
    }

    // Catalogue attached inputs (files / pasted text) as artifacts of this chat &
    // project, so the gallery holds the whole working set — inputs and outputs.
    if (!regen) {
      for (const a of atts) {
        if (a.kind === 'image' && a.path) {
          try { void window.api.saveArtifact?.({ kind: 'image', code: a.path, title: a.name, conversationId: convId, projectId: activeProjectId }); } catch { /* ignore */ }
        } else if (a.text) {
          try { void window.api.saveArtifact?.({ kind: 'text', code: a.text, title: a.name, conversationId: convId, projectId: activeProjectId }); } catch { /* ignore */ }
        }
      }
    }

    // Image-generation mode: render a prompt → image instead of a memory answer.
    if (mode === 'image') {
      setImgProgress(null);
      try {
        const seedNum = imgSeed.trim() === '' ? -1 : parseInt(imgSeed, 10);
        const styleObj = STYLE_PRESETS.find(s => s.name === activeStyle);
        const fullPrompt = styleObj ? `${trimmed}, ${styleObj.prompt}` : trimmed;
        const img = await window.api.generateImage({
          prompt: fullPrompt,
          negativePrompt: imgNegative.trim() || undefined,
          width: imgSize,
          height: imgSize,
          steps: imgSteps,
          seed: Number.isNaN(seedNum) ? -1 : seedNum,
          model: imgModel || undefined,
          initImage: imgInit || undefined,
          strength: imgInit ? imgStrength : undefined,
          conversationId: activeConversationId || undefined,
          projectId: activeProjectId,
        });
        const assistantMessage: ChatMessage = {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: `Generated for: ${trimmed}`,
          image: img.dataUrl,
          imagePath: img.path,
        };
        setMessages(prev => [...prev, assistantMessage]);
        try {
          await window.api.addRagMessage(convId, 'assistant', `Generated for: ${trimmed}`, { image: img.path });
        } catch (_) { /* ignore */ }
      } catch (e) {
        const errorContent = (e as Error)?.message || 'Image generation failed.';
        // User-cancelled: just drop the loading state, no error bubble.
        if (!/cancel/i.test(errorContent)) {
          console.error('Image generation failed', e);
          setMessages(prev => [...prev, { id: `a-${Date.now()}`, role: 'assistant', content: errorContent }]);
          try {
            await window.api.addRagMessage(convId, 'assistant', errorContent);
          } catch (_) { /* ignore */ }
        }
      } finally {
        sendingRef.current = false;
        setLoading(false);
        setImgProgress(null);
        await loadConversations();
        drainQueue();
      }
      return;
    }

    try {
      // History: on regen the user turn is already in `messages` (drop anything
      // after it); on a normal send, append the new turn.
      let base: ChatMessage[];
      if (regen) {
        const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
        base = lastUserIdx >= 0 ? messages.slice(0, lastUserIdx + 1) : messages;
      } else {
        base = [...messages, { id: 'tmp', role: 'user', content: trimmed }];
      }
      const history = base.slice(-20).map(m => ({ role: m.role, content: m.content }));

      // Agentic tools path (opt-in, non-project). The model calls built-in tools,
      // plus (when Connectors is on) MCP connector tools — reads run inline, writes
      // are routed to the approval queue.
      if ((toolsOn || connectorsOn) && !activeProjectId) {
        const tr = await window.api.toolChat(modelQuery, history, { connectors: connectorsOn });
        const am: ChatMessage = {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: tr?.answer || 'No response returned.',
          toolCalls: (tr?.toolCalls || []).map((c: { name: string; result: string }) => ({ name: c.name, result: c.result })),
        };
        setMessages(prev => [...prev, am]);
        if (voiceMode) setAutoPlayId(am.id);
        try { await window.api.addRagMessage(convId, 'assistant', am.content); } catch (_) { /* ignore */ }
        return;
      }

      // Placeholder message that fills in live as tokens/reasoning stream in
      // (matched by streamId in the onRagStream subscription).
      const streamId = `a-${Date.now()}`;
      setMessages(prev => [...prev, { id: streamId, role: 'assistant', content: '', reasoning: '', streaming: true }]);
      const result = await window.api.ragChat(modelQuery, 'All', history, activeProjectId, convId, noMemory && !activeProjectId, streamId, thinkingEnabled, imagePaths);
      const assistantContent = result.answer || 'No response returned.';

      // The model decided this is an image request — replace the streamed turn
      // with on-device generation.
      const imgMatch = assistantContent.match(/```image\s*\n([\s\S]*?)```/i);
      if (imgMatch && window.api.generateImage) {
        const imgPrompt = imgMatch[1].trim();
        setMessages(prev => prev.map(m => (m.id === streamId ? { ...m, content: 'Generating image…', reasoning: undefined, streaming: false } : m)));
        try {
          const img = await window.api.generateImage({ prompt: imgPrompt, conversationId: convId, projectId: activeProjectId });
          setMessages(prev => prev.map(m => (m.id === streamId ? { ...m, content: `Generated: ${imgPrompt.slice(0, 80)}`, image: img.dataUrl, imagePath: img.path } : m)));
          try { await window.api.addRagMessage(convId, 'assistant', `Generated: ${imgPrompt.slice(0, 80)}`, { image: img.path }); } catch (_) { /* ignore */ }
        } catch (err) {
          const msg = (err as Error)?.message || 'Image generation failed.';
          if (!/cancel/i.test(msg)) setMessages(prev => prev.map(m => (m.id === streamId ? { ...m, content: msg, streaming: false } : m)));
        }
      } else {
        // Finalize the streamed message — set authoritative text + context, clear streaming.
        // If this was a regenerate, keep the prior answer(s) as navigable variants.
        const priorVariants = pendingVariantsRef.current;
        pendingVariantsRef.current = null;
        const allVariants = priorVariants ? [...priorVariants, assistantContent] : undefined;
        setMessages(prev => prev.map(m => (m.id === streamId ? { ...m, content: assistantContent, context: result.context, streaming: false, variants: allVariants, variantIndex: allVariants ? allVariants.length - 1 : undefined } : m)));
        const art = parseArtifact(assistantContent);
        if (art) {
          // Inline-first: don't force the canvas open — the user opens the live
          // preview via the artifact card when they want it. Still save it, scoped
          // to this chat + project so the gallery can filter.
          try { void window.api.saveArtifact?.({ kind: art.kind, code: art.code, conversationId: convId, projectId: activeProjectId }); } catch { /* ignore */ }
        }
        if (voiceMode) setAutoPlayId(streamId);
        try {
          await window.api.addRagMessage(convId, 'assistant', assistantContent, result.context);
        } catch (e) {
          console.error('Failed to persist assistant message:', e);
        }
      }
    } catch (e) {
      console.error('RAG chat failed', e);
      const errorContent = 'Sorry, something went wrong while generating a response.';
      setMessages(prev => [...prev, { id: `a-${Date.now()}`, role: 'assistant', content: errorContent }]);
      try {
        await window.api.addRagMessage(convId, 'assistant', errorContent);
      } catch (_) { /* ignore */ }
    } finally {
      sendingRef.current = false;
      setLoading(false);
      setGeneratingConvId(null);
      await loadConversations();
      drainQueue();
    }
  };

  // Pull the next queued message (sent while a generation was in flight) and send it.
  const drainQueue = (): void => {
    const next = queueRef.current.shift();
    if (next === undefined) return;
    setQueued(q => q.slice(1));
    setTimeout(() => { void sendMessage(next.text || ' ', { atts: next.atts }); }, 30);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Slash skill autocomplete: while typing "/name" (before any space), Tab —
    // or Enter on a not-yet-complete name — fills in the top matching skill.
    const sq = input.startsWith('/') && !/\s/.test(input) ? input.slice(1).toLowerCase() : null;
    if (sq !== null) {
      const matches = skills.filter(s => s.name.toLowerCase().includes(sq));
      const exact = skills.some(s => s.name.toLowerCase() === sq);
      if (matches.length > 0 && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !exact))) {
        e.preventDefault();
        setInput(`/${matches[0].name} `);
        inputRef.current?.focus();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Voice input: record from the mic, transcribe on-device with whisper, then
  // drop the text into the input for review (not auto-sent).
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      const startedAt = Date.now();
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        if (blob.size === 0) return;
        setTranscribing(true);
        try {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const text = await window.api.transcribeAudio(bytes, 'webm');
          const clean = (text || '').trim();
          if (voiceMode) {
            // Voice mode: send the spoken note straight away, keeping the recording
            // so the user's bubble plays back their own audio.
            if (!clean) return;
            const url = URL.createObjectURL(blob);
            void sendMessage(clean, { voiceClip: { url, duration: (Date.now() - startedAt) / 1000 } });
          } else if (clean) {
            setInput(prev => (prev ? prev + ' ' : '') + clean);
          }
        } catch (err) {
          console.error('Transcription failed', err);
        } finally {
          setTranscribing(false);
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch (err) {
      console.error('Mic access failed', err);
      setRecording(false);
    }
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  };

  const toggleRecording = () => { recording ? stopRecording() : startRecording(); };

  // Voice output: synthesize a message on-device (Kokoro) and play it. Toggling
  // the same message stops playback.
  const speakMessage = useCallback(async (id: string, text: string) => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    // Toggle off if this message is already loading or playing.
    if (speakingId === id || speakLoadingId === id) { setSpeakingId(null); setSpeakLoadingId(null); return; }
    setSpeakLoadingId(id); // generating on-device — show a loading state
    try {
      const { dataUrl } = await window.api.speak(text);
      if (!dataUrl) throw new Error('empty dataUrl');
      const audio = new Audio(dataUrl);
      audioRef.current = audio;
      audio.onended = () => { setSpeakingId(cur => (cur === id ? null : cur)); audioRef.current = null; };
      audio.onerror = () => { console.error('[tts] audio element error', audio.error); setSpeakingId(cur => (cur === id ? null : cur)); setSpeakLoadingId(cur => (cur === id ? null : cur)); };
      await audio.play();
      setSpeakLoadingId(cur => (cur === id ? null : cur));
      setSpeakingId(id); // now actually speaking
    } catch (e) {
      console.error('[tts] failed', e);
      setSpeakLoadingId(cur => (cur === id ? null : cur));
      setSpeakingId(cur => (cur === id ? null : cur));
    }
  }, [speakingId, speakLoadingId]);

  const refreshGallery = useCallback(async () => {
    const scope = galleryScope === 'chat' ? { conversationId: activeConversationId || '__none__' }
      : galleryScope === 'project' ? { projectId: activeProjectId }
      : undefined;
    try { setGallery((await window.api.listGeneratedImages?.(scope)) || []); } catch (e) { console.error(e); }
    try { setArtifacts((await window.api.listArtifacts?.(scope)) || []); } catch (e) { console.error(e); }
  }, [galleryScope, activeConversationId, activeProjectId]);

  // Reload the gallery's artifacts whenever the scope changes while it's open.
  useEffect(() => { if (showGallery) void refreshGallery(); }, [galleryScope, showGallery, refreshGallery]);

  const deleteArtifact = useCallback(async (id: string) => {
    try {
      await window.api.deleteArtifact?.(id);
      setArtifacts(prev => prev.filter(a => a.id !== id));
    } catch (e) { console.error(e); }
  }, []);

  // Right-side panels are mutually exclusive — opening one closes the others so
  // they never overlap (one common docked panel slot).
  const closePanels = useCallback(() => {
    setCanvasArtifact(null); setSkillsOpen(false); setSettingsOpen(false); setViewer(null); setShowGallery(false); setModelPickerOpen(false);
  }, []);
  const openCanvas = useCallback((a: Artifact) => { closePanels(); setCanvasArtifact(a); }, [closePanels]);

  const openGallery = useCallback(() => {
    if (showGallery) { setShowGallery(false); return; }
    // Default the scope to the current context: a project → that project's items,
    // otherwise this chat's items. (User can switch to All.)
    setGalleryScope(activeProjectId ? 'project' : 'chat');
    // Close the OTHER panels (closePanels also clears showGallery), then open —
    // setShowGallery(true) runs last so it wins. The scope effect refreshes.
    closePanels(); setShowGallery(true);
  }, [showGallery, activeProjectId, closePanels]);

  const downloadImage = useCallback(async (path?: string, name?: string) => {
    if (!path) return;
    try { await window.api.exportGeneratedImage?.(path, name || 'off-grid-image.png'); } catch (e) { console.error(e); }
  }, []);

  const deleteImage = useCallback(async (path?: string) => {
    if (!path) return;
    try {
      await window.api.deleteGeneratedImage?.(path);
      setMessages(prev => prev.map(m => (m.imagePath === path ? { ...m, image: undefined, imagePath: undefined, content: m.content + '  (deleted)' } : m)));
      setGallery(prev => prev.filter(g => g.path !== path));
      setLightbox(null);
    } catch (e) { console.error(e); }
  }, []);

  // Auto-grow the composer with its content, up to a cap (then it scrolls).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 208)}px`;
  }, [input]);

  useEffect(() => {
    window.api.listSkills?.().then(s => setSkills(s || [])).catch(() => {});
  }, []);

  // Live streaming: route token/reasoning events to the in-flight assistant
  // message (matched by streamId === message id) so it fills in as it generates.
  useEffect(() => {
    const off = window.api.onRagStream?.((data) => {
      setMessages(prev => prev.map(m => {
        if (m.id !== data.streamId) return m;
        if (data.type === 'content') return { ...m, content: (m.content || '') + (data.text || '') };
        if (data.type === 'reasoning') return { ...m, reasoning: (m.reasoning || '') + (data.text || '') };
        if (data.type === 'step') return { ...m, activity: data.step as ChatMessage['activity'] };
        return m;
      }));
    });
    return () => off?.();
  }, []);

  const copyText = useCallback((t: string) => {
    try { void navigator.clipboard.writeText(t); } catch (e) { console.error(e); }
  }, []);

  // Re-run the user prompt that produced (or precedes) a given message.
  const regenerate = useCallback((messageId: string) => {
    const idx = messages.findIndex(m => m.id === messageId);
    if (idx < 0) return;
    // Regenerating an assistant answer keeps prior answers as navigable variants.
    const target = messages[idx];
    if (target.role === 'assistant' && target.content.trim()) {
      pendingVariantsRef.current = target.variants && target.variants.length ? target.variants : [target.content];
    }
    // Walk back to the user turn that produced this answer.
    for (let i = idx; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const content = messages[i].content;
        // Drop everything after that user turn (the old answer) and re-run in
        // place — no new user bubble. Also prune the persisted rows so reopening
        // the chat doesn't show old answers stacked.
        setMessages(prev => prev.slice(0, i + 1));
        if (activeConversationId) void window.api.truncateRagMessages?.(activeConversationId, i + 1);
        void sendMessage(content, { regen: true });
        return;
      }
    }
  }, [messages]);

  // Edit a sent message: replace its text, drop everything after it, re-run.
  const saveEdit = useCallback((id: string) => {
    const text = editText.trim();
    setEditingId(null);
    if (!text) return;
    const idx = messages.findIndex(m => m.id === id);
    if (idx < 0) return;
    setMessages(prev => prev.slice(0, idx + 1).map((m, i) => (i === idx ? { ...m, content: text } : m)));
    // Persist the edit: drop the old user row + everything after, re-add the
    // edited message, then regenerate the answer onto it.
    const cid = activeConversationId;
    if (cid) void window.api.truncateRagMessages?.(cid, idx).then(() => window.api.addRagMessage(cid, 'user', text));
    void sendMessage(text, { regen: true });
  }, [editText, messages, activeConversationId]);

  // Process attached files into text (read/parse/caption/transcribe) on the main side.
  const addFiles = useCallback(async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      // Show images as images straight away (local preview) so an upload reads as
      // an image while it captions in the background, not a generic TEXT box.
      const isImg = file.type.startsWith('image/');
      const preview = isImg ? URL.createObjectURL(file) : undefined;
      setAttachments(prev => [...prev, { id, name: file.name, kind: isImg ? 'image' : 'text', text: '', preview, status: 'loading' }]);
      try {
        const buf = await file.arrayBuffer();
        const res = await window.api.processFile?.(buf, file.name);
        // Images are "ready" if we have the file path (even with no caption), so the
        // actual image still gets sent to the vision model.
        const ok = !!res && (!!res.text || (res.kind === 'image' && !!res.path));
        setAttachments(prev => prev.map(a => a.id === id
          ? { ...a, kind: (res?.kind as Attachment['kind']) || (isImg ? 'image' : 'text'), text: res?.text || '', path: res?.path, preview, status: ok ? 'ready' : 'error' }
          : a));
      } catch (e) {
        console.error('process file failed', e);
        setAttachments(prev => prev.map(a => (a.id === id ? { ...a, status: 'error' } : a)));
      }
    }
  }, []);

  const removeAttachment = useCallback((id: string) => setAttachments(prev => prev.filter(a => a.id !== id)), []);

  // Pasting an image (e.g. a screenshot) attaches it; a large text blob becomes a
  // "PASTED" chip instead of flooding the input.
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(e.clipboardData.files).filter(f => f.type.startsWith('image/'));
    if (imageFiles.length) {
      e.preventDefault();
      void addFiles(imageFiles);
      return;
    }
    const text = e.clipboardData.getData('text');
    if (text && text.length > 1200) {
      e.preventDefault();
      const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setAttachments(prev => [...prev, { id, name: 'Pasted text', kind: 'pasted', text, status: 'ready' }]);
    }
  }, [addFiles]);

  const examples = mode === 'image' ? IMAGE_EXAMPLES : ASK_EXAMPLES;

  // Slash-command autocomplete: typing "/" (before any space) lists matching skills.
  const slashQuery = mode === 'ask' && input.startsWith('/') && !/\s/.test(input) ? input.slice(1).toLowerCase() : null;
  const skillMatches = slashQuery !== null ? skills.filter(s => s.name.toLowerCase().includes(slashQuery)) : [];

  return (
    <div
      className="flex h-full flex-col font-mono bg-neutral-950 transition-[padding] duration-200"
      style={{
        paddingRight: canvasArtifact
          ? canvasWidth
            ? `${canvasWidth}px` // canvas open + resized → reflow content to its width
            : 'max(360px, 30vw)'
          : skillsOpen || settingsOpen || viewer || showGallery || modelPickerOpen
            ? 'max(420px, 30vw)'
            : undefined,
      }}
    >
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-neutral-900 px-6 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900">
          <svg className="h-4 w-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium tracking-wide text-neutral-200">OFF GRID</h2>
          <p className="truncate text-xs text-neutral-500">Private, on-device — chat, generate, and build</p>
        </div>


        {/* Active models — pick the model per modality (text/image/voice/STT) */}
        <button
          onClick={() => { closePanels(); setModelPickerOpen(true); }}
          className={`rounded-md border p-1.5 transition-colors ${modelPickerOpen ? 'border-green-500 text-green-500' : 'border-neutral-800 text-neutral-500 hover:text-neutral-300'}`}
          title="Active models"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <rect x="4" y="4" width="16" height="16" rx="2" strokeWidth={2} />
            <path strokeLinecap="round" strokeWidth={2} d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
          </svg>
        </button>

        {/* Settings — model params, voice, tools, connectors (right-side panel) */}
        <button
          onClick={() => { closePanels(); setSettingsOpen(true); }}
          className={`rounded-md border p-1.5 transition-colors ${settingsOpen ? 'border-green-500 text-green-500' : 'border-neutral-800 text-neutral-500 hover:text-neutral-300'}`}
          title="Settings"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
        <button
          onClick={openGallery}
          className={`rounded-md border p-1.5 transition-colors ${showGallery ? 'border-green-500 text-green-500' : 'border-neutral-800 text-neutral-500 hover:text-neutral-300'}`}
          title="Generated images"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 15l4-4 4 4 3-3 5 5" />
            <circle cx="9" cy="9" r="1.5" fill="currentColor" />
          </svg>
        </button>
        <button
          onClick={() => setVoiceMode(v => !v)}
          className={`rounded-md border p-1.5 transition-colors ${voiceMode ? 'border-green-500 text-green-500' : 'border-neutral-800 text-neutral-500 hover:text-neutral-300'}`}
          title={voiceMode ? 'Voice mode on — speak and listen in voice notes' : 'Voice mode off'}
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5L6 9H2v6h4l5 4V5z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14" />
          </svg>
        </button>
        <button
          onClick={() => setShowHistory(prev => !prev)}
          className={`rounded-md border p-1.5 transition-colors ${showHistory ? 'border-neutral-700 text-neutral-300' : 'border-neutral-800 text-neutral-500 hover:text-neutral-300'}`}
          title={showHistory ? 'Collapse sidebar (full-screen chat)' : 'Show conversations'}
        >
          {/* Sidebar / panel-left icon — collapse the conversation rail */}
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <rect x="3" y="4" width="18" height="16" rx="2" strokeWidth={2} />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 4v16" />
          </svg>
        </button>
      </header>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        {/* History rail — animated collapse (width slides to 0) */}
        <aside className={`shrink-0 overflow-hidden border-neutral-900 transition-[width] duration-300 ease-in-out ${showHistory ? 'w-64 border-r' : 'w-0'}`}>
          <div className="flex h-full w-64 flex-col">
            <div className="p-3">
              <button
                onClick={startNewConversation}
                className="flex w-full items-center justify-center gap-2 rounded-md border border-neutral-800 px-3 py-2 text-xs text-neutral-300 transition-colors hover:border-green-500 hover:text-green-500"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                New chat
              </button>
            </div>
            {conversations.length > 0 && (
              <div className="px-2 pb-2">
                <div className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 focus-within:border-neutral-600">
                  <svg className="h-3.5 w-3.5 shrink-0 text-neutral-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                  <input
                    value={convSearch}
                    onChange={e => setConvSearch(e.target.value)}
                    placeholder="Search conversations…"
                    className="w-full bg-transparent text-xs text-neutral-200 placeholder-neutral-600 outline-none"
                  />
                  {convSearch && <button onClick={() => setConvSearch('')} className="shrink-0 text-neutral-600 hover:text-neutral-300">✕</button>}
                </div>
              </div>
            )}
            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {(() => {
                const q = convSearch.trim().toLowerCase();
                const filtered = q ? conversations.filter(c => (c.title || '').toLowerCase().includes(q)) : conversations;
                if (conversations.length === 0) return <p className="px-2 py-4 text-center text-xs text-neutral-600">No conversations yet</p>;
                if (filtered.length === 0) return <p className="px-2 py-4 text-center text-xs text-neutral-600">No matches</p>;
                const now = new Date();
                const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
                const groups: { label: string; items: Conversation[] }[] = [
                  { label: 'Today', items: [] }, { label: 'Yesterday', items: [] }, { label: 'This week', items: [] }, { label: 'Older', items: [] },
                ];
                for (const c of filtered) {
                  const t = new Date(c.updated_at).getTime();
                  if (t >= startToday) groups[0].items.push(c);
                  else if (t >= startToday - 86400000) groups[1].items.push(c);
                  else if (t >= startToday - 6 * 86400000) groups[2].items.push(c);
                  else groups[3].items.push(c);
                }
                return groups.filter(g => g.items.length).map(g => (
                  <div key={g.label} className="mb-2">
                    <div className="px-1 py-1 text-[10px] uppercase tracking-wider text-neutral-600">{g.label}</div>
                    {g.items.map(conv => (
                      <div
                        key={conv.id}
                        onClick={() => switchConversation(conv.id)}
                        className={`group flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors ${
                          activeConversationId === conv.id ? 'border-neutral-800 bg-neutral-900' : 'border-transparent hover:bg-neutral-900/50'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs text-neutral-300">{conv.title || 'Untitled'}</p>
                          <div className="mt-0.5 flex items-center gap-2">
                            <span className="text-[10px] text-neutral-600">{timeAgo(conv.updated_at)}</span>
                            {conv.project_id && <span className="text-[10px] text-green-500/70">project</span>}
                          </div>
                        </div>
                        <button
                          onClick={(e) => deleteConversation(conv.id, e)}
                          className="shrink-0 text-neutral-700 opacity-0 transition hover:text-red-400 group-hover:opacity-100"
                          title="Delete conversation"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                ));
              })()}
            </div>
          </div>
        </aside>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Chat tabs — quick-switch between open conversations */}
          {(openTabs.length > 0 || activeConversationId) && (
            <div className="flex items-center gap-1 overflow-x-auto border-b border-neutral-900 px-2 py-1">
              {openTabs.map(id => {
                const t = conversations.find(c => c.id === id);
                const active = activeConversationId === id;
                return (
                  <div key={id} className={`group flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${active ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900'}`}>
                    <button onClick={() => switchConversation(id)} className="max-w-[12rem] truncate">{t?.title || 'Untitled'}</button>
                    <button onClick={() => closeTab(id)} className="text-neutral-600 transition-colors hover:text-red-400" title="Close tab">✕</button>
                  </div>
                );
              })}
              {!activeConversationId && (
                <div className="flex shrink-0 items-center rounded-md bg-neutral-800 px-2.5 py-1 text-xs text-neutral-100">New chat</div>
              )}
              <button onClick={startNewConversation} className="shrink-0 rounded-md px-2 py-1 text-neutral-500 transition-colors hover:text-green-500" title="New tab">+</button>
            </div>
          )}
          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            {messages.length === 0 ? (
              <div className={`mx-auto flex min-h-full flex-col items-center justify-center px-6 py-6 text-center ${mode === 'image' ? 'max-w-6xl' : 'max-w-2xl'}`}>
                <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl border border-neutral-800 bg-neutral-900 shadow-sm">
                  <svg className="h-8 w-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                  </svg>
                </div>
                <h2 className="text-3xl font-semibold tracking-tight text-neutral-100">{mode === 'image' ? 'Create an image' : 'Start a conversation'}</h2>
                <p className="mt-3 max-w-md text-sm text-neutral-500">
                  {mode === 'image'
                    ? 'Pick a style, then describe your subject — generated on-device.'
                    : activeProjectName
                      ? `Grounded in the “${activeProjectName}” knowledge base.`
                      : 'Ask across your memories, chats, and entities from every source.'}
                </p>
                {mode === 'image' ? (
                  <div className="mt-4 w-full">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wider text-neutral-600">Style</span>
                      {Object.keys(styleThumbs).length < STYLE_PRESETS.length && (
                        <button
                          onClick={generateStylePreviews}
                          disabled={genThumbsBusy}
                          className="text-[10px] text-neutral-500 transition-colors hover:text-green-500 disabled:opacity-50"
                        >
                          {genThumbsBusy ? 'Generating previews…' : 'Generate previews'}
                        </button>
                      )}
                    </div>
                    <div className="grid w-full grid-cols-2 gap-2.5 sm:grid-cols-4">
                      {STYLE_PRESETS.map(s => {
                        const thumb = styleThumbs[styleKey(s.name)];
                        return (
                          <button
                            key={s.name}
                            onClick={() => setActiveStyle(cur => (cur === s.name ? null : s.name))}
                            className={`group relative aspect-[16/9] overflow-hidden rounded-md border transition-all ${
                              activeStyle === s.name ? 'border-green-500 ring-1 ring-green-500' : 'border-neutral-800 hover:border-neutral-600'
                            }`}
                          >
                            {thumb ? (
                              <img
                                src={`ogcapture://${thumb}`}
                                alt={s.name}
                                className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                              />
                            ) : (
                              <span className={`absolute inset-0 bg-gradient-to-br ${s.swatch} transition-transform duration-300 group-hover:scale-105`} />
                            )}
                            <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5 text-left text-[11px] font-medium text-white">
                              {s.name}
                            </span>
                            {activeStyle === s.name && (
                              <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-green-500 text-neutral-950">
                                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="mt-6 grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
                    {examples.map(ex => (
                      <button
                        key={ex}
                        onClick={() => sendMessage(ex)}
                        className="rounded-md border border-neutral-800 px-3 py-2.5 text-left text-xs text-neutral-400 transition-colors hover:border-green-500 hover:text-neutral-200"
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="w-full px-6 py-5">
                {messages.map(message => (
                  voiceMode ? (
                  <div key={message.id} className={`mb-4 flex flex-col ${message.role === 'user' ? 'items-end' : 'items-start'}`}>
                    {(() => {
                      if (message.role === 'user') {
                        return (
                          <VoiceBubble
                            messageId={message.id}
                            isUser
                            transcript={message.content}
                            audioUrl={message.audioUrl}
                            durationSeconds={message.audioDuration}
                            synthesize={(t) => window.api.speak(t)}
                            onCopy={copyText}
                          />
                        );
                      }
                      // Generated image in voice mode: show the image, no audio bubble.
                      if (message.image) {
                        return (
                          <img
                            src={message.image}
                            alt="Generated"
                            onClick={() => setLightbox({ url: message.image as string, path: message.imagePath })}
                            className="max-w-[20rem] cursor-zoom-in rounded-md border border-neutral-800 transition-opacity hover:opacity-90"
                          />
                        );
                      }
                      const transcript = (message.variants && message.variantIndex != null ? message.variants[message.variantIndex] : message.content)
                        .replace(ASK_FENCE, '').replace(ARTIFACT_FENCE, '').replace(/\[S(\d+)\]/g, '').trim();
                      return (
                        <VoiceBubble
                          messageId={message.id}
                          transcript={transcript}
                          isLoading={!!message.streaming}
                          autoPlay={autoPlayId === message.id}
                          synthesize={(t) => window.api.speak(t)}
                          onCopy={copyText}
                          onRetry={() => regenerate(message.id)}
                        />
                      );
                    })()}
                  </div>
                  ) : (
                  <div key={message.id} className={`mb-5 flex flex-col ${message.role === 'user' ? 'items-end' : 'items-start'}`}>
                    {message.role === 'assistant' && !message.streaming && message.reasoning && message.reasoning.trim() ? (
                      <Collapsible className="mb-1.5 max-w-[85%]">
                        <CollapsibleTrigger className="group flex items-center gap-1.5 text-[11px] text-neutral-500 transition-colors hover:text-neutral-300">
                          <svg className="h-3 w-3 text-neutral-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3a6 6 0 00-3.6 10.8c.3.225.45.6.45.975V16.5h6.3v-1.725c0-.375.15-.75.45-.975A6 6 0 0012 3z" /></svg>
                          Thought process
                          <svg className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                        </CollapsibleTrigger>
                        <CollapsibleContent className="mt-1 whitespace-pre-wrap border-l-2 border-neutral-800 pl-3 text-xs leading-relaxed text-neutral-500">
                          {message.reasoning}
                        </CollapsibleContent>
                      </Collapsible>
                    ) : null}
                    <div
                      className={
                        message.role === 'assistant' && message.streaming && !message.content.trim()
                          ? 'hidden'
                          : `max-w-[85%] rounded-md px-3.5 py-2.5 text-sm leading-relaxed ${
                              message.role === 'user'
                                ? 'bg-neutral-800 text-neutral-100'
                                : 'border border-neutral-800 bg-neutral-900/40 text-neutral-200'
                            }`
                      }
                    >
                      {message.attachments && message.attachments.length > 0 ? (
                        <div className="mb-2 flex flex-wrap gap-1.5">
                          {message.attachments.map((att, i) => {
                            const viewable = !!att.text || (att.kind === 'image' && !!att.path);
                            return (
                              <button
                                key={i}
                                type="button"
                                disabled={!viewable}
                                onClick={() => {
                                  if (att.kind === 'image' && att.path) { closePanels(); setLightbox({ url: `ogcapture://${att.path}`, path: att.path }); }
                                  else if (att.text) { closePanels(); setViewer({ title: att.kind === 'pasted' ? 'Pasted text' : att.name, text: att.text }); }
                                }}
                                title={viewable ? 'Click to view' : undefined}
                                className="flex items-center gap-1 rounded-md bg-neutral-700/60 px-2 py-1 text-[10px] text-neutral-200 transition-colors enabled:cursor-pointer enabled:hover:bg-neutral-600/60"
                              >
                                <svg className="h-3 w-3 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                                <span className="max-w-[12rem] truncate">{att.name}</span>
                                <span className="text-neutral-500">{att.kind}</span>
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                      {editingId === message.id ? (
                        <div className="flex flex-col gap-2">
                          <textarea
                            autoFocus
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(message.id); } if (e.key === 'Escape') setEditingId(null); }}
                            rows={Math.min(10, editText.split('\n').length + 1)}
                            className="w-full resize-none rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-green-500"
                          />
                          <div className="flex gap-2">
                            <button onClick={() => saveEdit(message.id)} className="rounded-md bg-green-600 px-3 py-1 text-xs text-white transition-colors hover:bg-green-500">Save & submit</button>
                            <button onClick={() => setEditingId(null)} className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-400 transition-colors hover:text-neutral-200">Cancel</button>
                          </div>
                        </div>
                      ) : (
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkBreaks]}
                        components={message.role === 'assistant' ? makeCiteComponents(message.context?.unified) : markdownComponents}
                      >
                        {message.role !== 'assistant'
                          ? message.content
                          // Show the selected regenerated variant (if any); keep artifact code
                          // inline; hide only the clarifying-question fence.
                          : (message.variants && message.variantIndex != null ? message.variants[message.variantIndex] : message.content).replace(ASK_FENCE, '').replace(/\[S(\d+)\]/g, '[S$1](cite:$1)').trim()}
                      </ReactMarkdown>
                      )}
                      {(() => {
                        if (message.role !== 'assistant') return null;
                        const art = parseArtifact(message.content);
                        if (!art) return null;
                        return (
                          <button
                            type="button"
                            onClick={() => openCanvas(art)}
                            className="mt-2 flex w-full items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2.5 text-left transition-colors hover:border-green-500/60"
                          >
                            <span className="flex h-9 w-9 items-center justify-center rounded-md border border-neutral-800 bg-neutral-950 text-green-500">
                              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs text-neutral-200">{art.title || `${art.kind.toUpperCase()} artifact`}</span>
                              <span className="block text-[11px] text-neutral-500">Click to open in the canvas →</span>
                            </span>
                          </button>
                        );
                      })()}
                      {(() => {
                        if (message.role !== 'assistant') return null;
                        const ask = parseAsk(message.content);
                        if (!ask) return null;
                        const sel = askSel[message.id] || [];
                        return (
                          <div className="mt-2 flex flex-col gap-1.5">
                            <p className="text-xs text-neutral-400">{ask.question}</p>
                            <div className="flex flex-wrap gap-1.5">
                              {ask.options.map(opt => {
                                const on = sel.includes(opt);
                                return (
                                  <button
                                    key={opt}
                                    onClick={() => {
                                      if (ask.multiSelect) {
                                        setAskSel(prev => ({ ...prev, [message.id]: on ? sel.filter(o => o !== opt) : [...sel, opt] }));
                                      } else {
                                        void sendMessage(opt);
                                      }
                                    }}
                                    className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${on ? 'border-green-500 text-green-500' : 'border-neutral-700 text-neutral-300 hover:border-green-500 hover:text-green-500'}`}
                                  >
                                    {opt}
                                  </button>
                                );
                              })}
                            </div>
                            {ask.multiSelect && sel.length > 0 ? (
                              <button onClick={() => void sendMessage(sel.join(', '))} className="mt-1 self-start rounded-md bg-green-600 px-3 py-1 text-xs text-white transition-colors hover:bg-green-500">
                                Submit ({sel.length})
                              </button>
                            ) : null}
                          </div>
                        );
                      })()}
                      {message.image ? (
                        <img
                          src={message.image}
                          alt="Generated"
                          onClick={() => setLightbox({ url: message.image as string, path: message.imagePath })}
                          className="mt-2 max-w-full cursor-zoom-in rounded-md border border-neutral-800 transition-opacity hover:opacity-90"
                        />
                      ) : null}
                    </div>

                    {message.role === 'assistant' && message.streaming ? (
                      <div className="mt-1.5 flex flex-col gap-1.5">
                        <span className="inline-flex gap-1 text-green-500">
                          <span className="animate-bounce [animation-delay:-0.3s]">●</span>
                          <span className="animate-bounce [animation-delay:-0.15s]">●</span>
                          <span className="animate-bounce">●</span>
                        </span>
                        {activityLabel(message.activity) ? (
                          <span className="text-[11px] text-neutral-500">{activityLabel(message.activity)}</span>
                        ) : null}
                        {message.reasoning && message.reasoning.trim() ? (
                          <Collapsible defaultOpen className="max-w-[85%]">
                            <CollapsibleTrigger className="group flex items-center gap-1.5 text-[11px] text-neutral-500 transition-colors hover:text-neutral-300">
                              <span>Thinking…</span>
                              <svg className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                            </CollapsibleTrigger>
                            <CollapsibleContent className="mt-1 whitespace-pre-wrap border-l-2 border-neutral-800 pl-3 text-xs leading-relaxed text-neutral-500">
                              {message.reasoning}
                            </CollapsibleContent>
                          </Collapsible>
                        ) : null}
                      </div>
                    ) : null}

                    {message.toolCalls && message.toolCalls.length > 0 ? (
                      <div className="mt-1.5 flex max-w-[85%] flex-wrap gap-1">
                        {message.toolCalls.map((tc, i) => (
                          <span key={i} className="rounded-sm border border-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500" title={tc.result}>
                            {tc.name} → {tc.result.length > 32 ? tc.result.slice(0, 32) + '…' : tc.result}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    {message.role === 'user' ? (
                      <div className="mt-1.5 flex items-center gap-3">
                        <button onClick={() => copyText(message.content)} className="flex items-center gap-1 text-[11px] text-neutral-600 transition-colors hover:text-green-500" title="Copy">
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16h8M8 12h8m-7 8h6a2 2 0 002-2V6a2 2 0 00-2-2h-3.586a1 1 0 00-.707.293l-2.414 2.414A1 1 0 009 7.414V18a2 2 0 002 2z" /></svg>
                          Copy
                        </button>
                        <button onClick={() => regenerate(message.id)} className="flex items-center gap-1 text-[11px] text-neutral-600 transition-colors hover:text-green-500" title="Regenerate the reply to this message">
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                          Resend
                        </button>
                        <button onClick={() => { setEditingId(message.id); setEditText(message.content); }} className="flex items-center gap-1 text-[11px] text-neutral-600 transition-colors hover:text-green-500" title="Edit this message">
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                          Edit
                        </button>
                      </div>
                    ) : null}

                    {message.role === 'assistant' && !message.image ? (
                      <div className="mt-1.5 flex items-center gap-3">
                        <button
                          onClick={() => speakMessage(message.id, message.content)}
                          className={`flex items-center gap-1 text-[11px] transition-colors ${speakingId === message.id || speakLoadingId === message.id ? 'text-green-500' : 'text-neutral-600 hover:text-green-500'}`}
                          title={speakLoadingId === message.id ? 'Generating…' : speakingId === message.id ? 'Stop' : 'Speak'}
                        >
                          {speakLoadingId === message.id ? (
                            <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                          ) : speakingId === message.id ? (
                            <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
                          ) : (
                            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5L6 9H2v6h4l5 4V5z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14" /></svg>
                          )}
                          {speakLoadingId === message.id ? 'Generating…' : speakingId === message.id ? 'Stop' : 'Speak'}
                        </button>
                        <button
                          onClick={() => copyText(message.content)}
                          className="flex items-center gap-1 text-[11px] text-neutral-600 transition-colors hover:text-green-500"
                          title="Copy"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16h8M8 12h8m-7 8h6a2 2 0 002-2V6a2 2 0 00-2-2h-3.586a1 1 0 00-.707.293l-2.414 2.414A1 1 0 009 7.414V18a2 2 0 002 2z" /></svg>
                          Copy
                        </button>
                        <button
                          onClick={() => regenerate(message.id)}
                          className="flex items-center gap-1 text-[11px] text-neutral-600 transition-colors hover:text-green-500"
                          title="Regenerate"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                          Regenerate
                        </button>
                        {message.variants && message.variants.length > 1 ? (
                          <span className="flex items-center gap-1 text-[11px] text-neutral-500">
                            <button
                              onClick={() => setMessages(prev => prev.map(m => (m.id === message.id ? { ...m, variantIndex: Math.max(0, (m.variantIndex ?? 0) - 1) } : m)))}
                              disabled={(message.variantIndex ?? 0) <= 0}
                              className="transition-colors hover:text-green-500 disabled:opacity-30"
                            >‹</button>
                            <span>{(message.variantIndex ?? 0) + 1}/{message.variants.length}</span>
                            <button
                              onClick={() => setMessages(prev => prev.map(m => (m.id === message.id ? { ...m, variantIndex: Math.min((m.variants?.length ?? 1) - 1, (m.variantIndex ?? 0) + 1) } : m)))}
                              disabled={(message.variantIndex ?? 0) >= message.variants.length - 1}
                              className="transition-colors hover:text-green-500 disabled:opacity-30"
                            >›</button>
                          </span>
                        ) : null}
                        {parseArtifact(message.content) ? (
                          <button
                            onClick={() => { const a = parseArtifact(message.content); if (a) openCanvas(a); }}
                            className="flex items-center gap-1 text-[11px] text-green-500 transition-colors hover:text-green-400"
                          >
                            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7h10v10M9 17H5a2 2 0 01-2-2V5a2 2 0 012-2h10a2 2 0 012 2v2" /></svg>
                            Open canvas
                          </button>
                        ) : null}
                      </div>
                    ) : null}

                    {message.role === 'assistant' && message.context && ((message.context.sources?.length || 0) + (message.context.memories?.length || 0) + (message.context.summaries?.length || 0) + (message.context.entities?.length || 0) + (message.context.entityFacts?.length || 0) + (message.context.unified?.length || 0)) > 0 ? (
                      <Collapsible className="mt-2 w-full max-w-[90%]">
                        <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-left text-xs text-neutral-400 transition-colors hover:border-neutral-700">
                          <svg className="h-3.5 w-3.5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                          <span className="flex-1">Searched your memory — {(message.context.sources?.length || 0) + (message.context.memories?.length || 0) + (message.context.summaries?.length || 0) + (message.context.entities?.length || 0) + (message.context.entityFacts?.length || 0) + (message.context.unified?.length || 0)} results</span>
                          <svg className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                        </CollapsibleTrigger>
                        <CollapsibleContent className="mt-1.5 max-h-[400px] max-w-full overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900/40 p-4 text-sm">

                        {message.context.unified && message.context.unified.length > 0 ? (
                          <div className="mb-3">
                            <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">Sources ({message.context.unified.length}) — cited as [S#]</div>
                            <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-3">
                              {message.context.unified.map((u, idx) => (
                                <button
                                  key={idx}
                                  type="button"
                                  onClick={() => {
                                    if (u.refId == null) return;
                                    if (u.kind === 'memory') onNavigateToMemory?.(u.refId);
                                    else if (u.kind === 'entity') onNavigateToEntity?.(u.refId);
                                    else if (u.kind === 'meeting') onNavigateToChat?.(String(u.refId));
                                  }}
                                  title={`${u.kind} · ${u.surface}${u.title ? ' · ' + u.title : ''}`}
                                  className="flex flex-col gap-1 rounded-md border border-neutral-800 p-2 text-left text-[11px] text-neutral-400 transition-colors hover:border-green-500"
                                >
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-semibold text-green-500">[S{idx + 1}]</span>
                                    <span className="rounded-sm border border-neutral-700 px-1 text-[9px] uppercase tracking-wide text-neutral-500">{u.kind}</span>
                                  </div>
                                  <span className="line-clamp-2 text-neutral-300">{u.title || u.snippet}</span>
                                  <span className="truncate text-[10px] text-neutral-600">{u.surface}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : null}

                        {message.context.sources && message.context.sources.length > 0 ? (
                          <div className="mb-3">
                            <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">Sources ({message.context.sources.length})</div>
                            <div className="space-y-1">
                              {message.context.sources.slice(0, 8).map((s, idx) => (
                                <div key={idx} className="flex items-center gap-2 rounded-md border border-neutral-800 p-2 text-[11px] text-neutral-400">
                                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                                  <span className="shrink-0 text-neutral-600">{(s.score * 100).toFixed(0)}%</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}

                        {message.context.masterMemory ? (
                          <div className="mb-3 rounded-md border border-neutral-800 p-3">
                            <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">Master memory</div>
                            <div className="text-neutral-300">
                              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
                                {message.context.masterMemory}
                              </ReactMarkdown>
                            </div>
                          </div>
                        ) : null}

                        {message.context.memories && message.context.memories.length > 0 ? (
                          <div className="mb-3">
                            <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">Memories ({message.context.memories.length})</div>
                            <div className="space-y-1">
                              {message.context.memories.slice(0, 5).map((memory: any, idx: number) => (
                                <button
                                  key={memory.id || idx}
                                  onClick={() => onNavigateToMemory?.(memory.id)}
                                  className="block w-full rounded-md border border-neutral-800 p-2 text-left transition-colors hover:border-neutral-700"
                                >
                                  <p className="line-clamp-2 text-[11px] text-neutral-400">{memory.content || memory.text || 'Memory'}</p>
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : null}

                        {message.context.summaries && message.context.summaries.length > 0 ? (
                          <div className="mb-3">
                            <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">Related chats ({message.context.summaries.length})</div>
                            <div className="space-y-1">
                              {message.context.summaries.slice(0, 5).map((summary: any, idx: number) => (
                                <button
                                  key={summary.session_id || idx}
                                  onClick={() => onNavigateToChat?.(summary.session_id)}
                                  className="block w-full rounded-md border border-neutral-800 p-2 text-left transition-colors hover:border-neutral-700"
                                >
                                  <p className="line-clamp-2 text-[11px] text-neutral-400">{summary.summary || summary.title || 'Chat'}</p>
                                  {summary.app_name && <span className="mt-1 inline-block text-[10px] text-neutral-600">{summary.app_name}</span>}
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : null}

                        {message.context.entities && message.context.entities.length > 0 ? (
                          <div className="mb-3">
                            <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">Entities ({message.context.entities.length})</div>
                            <div className="flex flex-wrap gap-1">
                              {message.context.entities.slice(0, 10).map((entity: any, idx: number) => (
                                <button
                                  key={entity.id || idx}
                                  onClick={() => onNavigateToEntity?.(entity.id)}
                                  className="rounded-md border border-neutral-800 px-2 py-1 text-[11px] text-neutral-400 transition-colors hover:border-green-500 hover:text-green-500"
                                >
                                  {entity.name || 'Entity'}
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : null}

                        {message.context.entityFacts && message.context.entityFacts.length > 0 ? (
                          <div>
                            <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">Entity facts ({message.context.entityFacts.length})</div>
                            <div className="space-y-1">
                              {message.context.entityFacts.slice(0, 5).map((fact: any, idx: number) => (
                                <div key={idx} className="rounded-md border border-neutral-800 p-2">
                                  <p className="line-clamp-2 text-[11px] text-neutral-400">{fact.fact || fact}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        </CollapsibleContent>
                      </Collapsible>
                    ) : null}
                  </div>
                  )
                ))}
                {loading && generatingConvId === activeConversationId && !messages.some(m => m.streaming) ? (
                  <div className="mb-5 flex flex-col items-start">
                    <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-600">Off Grid</div>
                    {mode === 'image' ? (
                      <div className="rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
                        {imgProgress?.preview ? (
                          <img src={imgProgress.preview} alt="forming" className="mb-2 w-56 rounded-md border border-neutral-800" />
                        ) : (
                          <div className="mb-2 flex h-56 w-56 items-center justify-center rounded-md border border-neutral-800 text-[11px] text-neutral-600">
                            warming up…
                          </div>
                        )}
                        <div className="flex items-center justify-between text-[11px] text-neutral-500">
                          <span>
                            {imgProgress ? `${imgProgress.phase === 'decoding' ? 'Decoding' : 'Step'} ${imgProgress.step}/${imgProgress.total}` : 'Loading model…'}
                          </span>
                          {imgProgress ? (
                            <span className="text-neutral-600">
                              ~{Math.max(0, Math.round((imgProgress.total - imgProgress.step) * imgProgress.secPerStep))}s left
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-1.5 h-1 w-56 overflow-hidden rounded-full bg-neutral-800">
                          <div
                            className="h-full bg-green-500 transition-all duration-300"
                            style={{ width: imgProgress ? `${(imgProgress.step / imgProgress.total) * 100}%` : '5%' }}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 px-3.5 py-2.5">
                        <span className="flex gap-1">
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-green-500 [animation-delay:0ms]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-green-500 [animation-delay:150ms]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-green-500 [animation-delay:300ms]" />
                        </span>
                        <span className="text-xs text-neutral-500">Searching your memory…</span>
                      </div>
                    )}
                  </div>
                ) : null}
                <div ref={bottomRef} className="h-2" />
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="border-t border-neutral-900 px-6 py-3">
            <div className="w-full px-6">
              {/* Image options (image mode, expandable) */}
              {mode === 'image' && showImageOptions && (
                <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-neutral-800 px-3 py-2 text-[11px] text-neutral-500">
                  {imgModels.length > 1 && (
                    <label className="flex items-center gap-1.5">
                      Model
                      <select value={imgModel} onChange={e => setImgModel(e.target.value)} className="max-w-[12rem] rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-300 outline-none focus:border-green-500">
                        {imgModels.map(m => <option key={m} value={m}>{m.replace(/\.gguf$/i, '').replace(/-Q\d.*$/i, '')}</option>)}
                      </select>
                    </label>
                  )}
                  <label className="flex items-center gap-1.5">
                    Size
                    <select value={imgSize} onChange={e => setImgSize(Number(e.target.value))} className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-300 outline-none focus:border-green-500">
                      <option value={512}>512</option>
                      <option value={640}>640</option>
                      <option value={768}>768</option>
                      <option value={1024}>1024</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-1.5">
                    Steps
                    <input type="number" min={4} max={50} value={imgSteps} onChange={e => setImgSteps(Math.max(4, Math.min(50, Number(e.target.value) || 16)))} className="w-14 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-300 outline-none focus:border-green-500" />
                  </label>
                  <label className="flex items-center gap-1.5">
                    Seed
                    <input value={imgSeed} onChange={e => setImgSeed(e.target.value.replace(/[^0-9]/g, ''))} placeholder="random" className="w-20 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-300 placeholder-neutral-700 outline-none focus:border-green-500" />
                  </label>
                  <input value={imgNegative} onChange={e => setImgNegative(e.target.value)} placeholder="Negative prompt" className="min-w-[10rem] flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-300 placeholder-neutral-700 outline-none focus:border-green-500" />
                  {imgInit ? (
                    <span className="flex items-center gap-2 rounded-md border border-green-500/40 px-2 py-1 text-green-500">
                      {imgInit.split('/').pop()}
                      <label className="flex items-center gap-1 text-neutral-500" title="img2img strength: how much to change the init image (0.1 = subtle, 1 = ignore it)">
                        Strength
                        <input type="number" min={0.1} max={1} step={0.05} value={imgStrength} onChange={e => setImgStrength(Math.max(0.1, Math.min(1, Number(e.target.value) || 0.6)))} className="w-14 rounded border border-neutral-800 bg-neutral-950 px-1.5 py-0.5 text-neutral-300 outline-none focus:border-green-500" />
                      </label>
                      <button onClick={() => setImgInit(null)} className="text-neutral-500 hover:text-red-400">✕</button>
                    </span>
                  ) : (
                    <button onClick={async () => { const p = await window.api.pickImageForGen?.(); if (p) setImgInit(p); }} className="rounded-md border border-neutral-800 px-2 py-1 text-neutral-400 transition-colors hover:border-green-500 hover:text-green-500">
                      + Init image
                    </button>
                  )}
                </div>
              )}

              {/* Active style chip (image mode) */}
              {mode === 'image' && activeStyle && (
                <div className="mb-2 flex items-center gap-2 text-[11px] text-neutral-500">
                  <span>Style</span>
                  <span className="rounded-md border border-green-500/40 px-2 py-0.5 text-green-500">{activeStyle}</span>
                  <button onClick={() => setActiveStyle(null)} className="text-neutral-600 transition-colors hover:text-red-400">clear</button>
                </div>
              )}

              {projCreating && (
                <div className="mb-2">
                  <input
                    autoFocus
                    value={projNewName}
                    onChange={(e) => setProjNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') createAndAssignProject();
                      if (e.key === 'Escape') { setProjCreating(false); setProjNewName(''); }
                    }}
                    onBlur={createAndAssignProject}
                    placeholder="New project name…  (Enter to create, Esc to cancel)"
                    className="w-full rounded-md border border-green-500 bg-neutral-900 px-3 py-2 text-xs text-white placeholder-neutral-600 outline-none"
                  />
                </div>
              )}

              {queued.length > 0 && (
                <div className="mb-2 flex flex-col gap-1">
                  {queued.map((q, i) => (
                    <div key={i} className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-1.5 text-[11px] text-neutral-400">
                      <svg className="h-3 w-3 shrink-0 text-neutral-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      <span className="flex-1 select-text cursor-text whitespace-pre-wrap break-words">{q.text || `(${q.atts.length} attachment${q.atts.length > 1 ? 's' : ''})`}</span>
                      {q.atts.length > 0 ? (
                        <span className="flex shrink-0 items-center gap-1 text-neutral-500" title={q.atts.map(a => a.name).join(', ')}>
                          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                          {q.atts.length}
                        </span>
                      ) : null}
                      <button onClick={() => copyText(q.text)} className="shrink-0 cursor-pointer text-neutral-600 transition-colors hover:text-green-500" title="Copy">
                        <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16h8M8 12h8m-7 8h6a2 2 0 002-2V6a2 2 0 00-2-2h-3.586a1 1 0 00-.707.293l-2.414 2.414A1 1 0 009 7.414V18a2 2 0 002 2z" /></svg>
                      </button>
                      <span className="shrink-0 text-neutral-600">queued</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Unified composer — the SAME toolbar (attach / image / project /
                  skills / tools / memory scope / thinking) serves chat and voice
                  mode; only the input surface (textarea vs. mic) differs. */}
              <div
                onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
                onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files); }}
                className={`relative rounded-2xl border bg-neutral-950 shadow-sm transition-colors ${dragOver ? 'border-green-500' : 'border-neutral-800 focus-within:border-neutral-600'}`}
              >
                {dragOver ? (
                  <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-2xl bg-neutral-950/80 text-xs text-green-500">Drop files to attach</div>
                ) : null}
                {skillMatches.length > 0 && (
                  <div className="absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden rounded-md border border-neutral-800 bg-neutral-950 py-1 text-sm shadow-lg">
                    <div className="flex items-center justify-between px-3 py-1 text-[10px] uppercase tracking-wide text-neutral-600">
                      <span>Skills</span>
                      <span className="normal-case text-neutral-700">Tab to complete</span>
                    </div>
                    {skillMatches.slice(0, 6).map((s, i) => (
                      <button
                        key={s.name}
                        onClick={() => { setInput(`/${s.name} `); inputRef.current?.focus(); }}
                        className={`flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-neutral-900 ${i === 0 ? 'bg-neutral-900/60' : ''}`}
                      >
                        <span className="text-green-500">/{s.name}</span>
                        {s.description ? <span className="line-clamp-1 text-[11px] text-neutral-500">{s.description}</span> : null}
                      </button>
                    ))}
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={e => { if (e.target.files?.length) void addFiles(e.target.files); e.target.value = ''; }}
                />
                {attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2 px-3 pt-3">
                    {attachments.map(a => (
                      <div key={a.id} className="group relative flex w-40 flex-col gap-1 rounded-lg border border-neutral-800 bg-neutral-900 p-2">
                        <button onClick={() => removeAttachment(a.id)} className="absolute -right-1.5 -top-1.5 z-10 flex h-4 w-4 items-center justify-center rounded-full border border-neutral-700 bg-neutral-950 text-[10px] text-neutral-400 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100">✕</button>
                        {a.kind === 'image' ? (
                          <button
                            type="button"
                            onClick={() => { const url = a.preview || (a.path ? `ogcapture://${a.path}` : ''); if (url) { closePanels(); setLightbox({ url, path: a.path }); } }}
                            title="Click to view"
                            className="relative h-[2.6rem] overflow-hidden rounded-md"
                          >
                            <img src={a.preview || (a.path ? `ogcapture://${a.path}` : '')} alt={a.name} className="h-full w-full object-cover" />
                            {a.status === 'loading' ? (
                              <span className="absolute inset-0 flex items-center justify-center bg-neutral-950/50 text-[9px] text-neutral-300">Reading…</span>
                            ) : null}
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={!a.text}
                            onClick={() => { if (a.text) { closePanels(); setViewer({ title: a.kind === 'pasted' ? 'Pasted text' : a.name, text: a.text }); } }}
                            title={a.text ? 'Click to expand' : undefined}
                            className="line-clamp-3 h-[2.6rem] overflow-hidden text-left text-[10px] leading-snug text-neutral-500 enabled:hover:text-neutral-300"
                          >
                            {a.status === 'loading' ? 'Processing…' : a.status === 'error' ? 'Could not read this file.' : (a.text.slice(0, 140) || a.name)}
                          </button>
                        )}
                        <div className="flex items-center justify-between">
                          <span className="truncate text-[10px] text-neutral-400" title={a.name}>{a.kind === 'pasted' ? '' : a.name}</span>
                          <span className="rounded-sm border border-neutral-700 px-1 py-0.5 text-[9px] uppercase tracking-wide text-neutral-400">
                            {a.kind === 'pasted' ? 'Pasted' : a.kind}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {voiceMode ? (
                  // Voice mode: the input surface is a single mic — record a note,
                  // it transcribes and sends. The toolbar below stays identical.
                  <button
                    type="button"
                    onClick={toggleRecording}
                    disabled={transcribing}
                    className={`flex w-full flex-col items-center gap-2 py-5 ${transcribing ? 'cursor-default' : 'cursor-pointer'}`}
                  >
                    <span className={`flex h-14 w-14 items-center justify-center rounded-full border-2 transition-colors ${recording ? 'border-red-500 bg-red-500/15 text-red-400' : 'border-green-500 bg-green-500/10 text-green-500 hover:bg-green-500/20'} ${transcribing ? 'opacity-50' : ''}`}>
                      {transcribing ? (
                        <svg className="h-6 w-6 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                      ) : recording ? (
                        <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                      ) : (
                        <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-14 0m7 7v3m0-3a4 4 0 01-4-4V5a4 4 0 018 0v6a4 4 0 01-4 4z" /></svg>
                      )}
                    </span>
                    <span className="text-xs text-neutral-500">
                      {transcribing ? 'Transcribing…' : recording ? 'Recording — tap to send' : 'Tap to record a voice note'}
                    </span>
                  </button>
                ) : (
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    rows={1}
                    placeholder={mode === 'image' ? 'Describe an image to generate…' : activeProjectName ? `Ask about “${activeProjectName}”…` : 'Ask anything…'}
                    className="max-h-52 w-full resize-none overflow-y-auto bg-transparent px-3.5 pt-3 text-sm text-neutral-200 placeholder-neutral-600 outline-none"
                  />
                )}
                <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
                  <div className="flex items-center gap-2">
                  {/* "+" menu — attach / image / project / tools */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="outline" size="icon" className="size-8 rounded-full"><Plus className="h-4 w-4" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-56">
                      <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                        <Paperclip /> Attach files
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled={!imageAvailable} onSelect={async () => { setMode('image'); const p = await window.api.pickImageForGen?.(); if (p) setImgInit(p); }}>
                        <ImageIcon /> Add image
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled={!imageAvailable} onSelect={() => setMode('image')}>
                        <Sparkles /> Generate image
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setProjCreating(true)}>
                        <FolderPlus /> Add to project
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => { closePanels(); setSkillsOpen(true); }}>
                        <Lightning /> Skills
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setToolsOn(t => !t); }}>
                        <Wrench /> <span className="flex-1">Tools</span>
                        <span className={`text-xs ${toolsOn ? 'text-primary' : 'text-muted-foreground'}`}>{toolsOn ? 'On' : 'Off'}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setConnectorsOn(t => !t); }}>
                        <Plug /> <span className="flex-1">Connectors</span>
                        <span className={`text-xs ${connectorsOn ? 'text-primary' : 'text-muted-foreground'}`}>{connectorsOn ? 'On' : 'Off'}</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">Coming soon</DropdownMenuLabel>
                      <DropdownMenuItem disabled><Search /> Web search</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  {/* Scope — Off Grid (default) or a project */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        title="Scope this chat to Off Grid or a project"
                        className={`h-8 gap-1.5 rounded-full ${activeProjectId ? 'border-green-500 text-primary' : 'text-neutral-400'}`}
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                        <span className="max-w-[9rem] truncate">{activeProjectName ?? 'Off Grid AI'}</span>
                        <CaretDown className="h-3 w-3 opacity-60" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-56">
                      <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">Scope this chat</DropdownMenuLabel>
                      <DropdownMenuItem onSelect={() => { setNoMemory(!isPro); assignProject(null); }}>
                        <span className={`flex-1 ${!activeProjectId ? 'text-primary' : ''}`}>Off Grid AI</span>
                      </DropdownMenuItem>
                      {projects.map(p => (
                        <DropdownMenuItem key={p.id} onSelect={() => { setNoMemory(false); assignProject(p.id); }}>
                          <span className={`flex-1 truncate ${activeProjectId === p.id ? 'text-primary' : ''}`}>{p.name}</span>
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => setProjCreating(true)}><FolderPlus /> New project</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setThinkingEnabled(t => !t)}
                        className={`h-8 gap-1.5 rounded-full ${thinkingEnabled ? 'border-green-500 text-primary' : 'text-neutral-400'}`}
                      >
                        <Brain className="h-3.5 w-3.5" /> Thinking
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{thinkingEnabled ? 'Reasoning on — the model thinks step by step (slower)' : 'Reasoning off — direct answers (faster)'}</TooltipContent>
                  </Tooltip>
                  {mode === 'image' && (
                    <Button type="button" variant="outline" size="sm" onClick={() => setShowImageOptions(o => !o)} className={`h-8 gap-1.5 rounded-full ${showImageOptions ? 'text-primary' : ''}`}>
                      <SlidersHorizontal className="h-3.5 w-3.5" /> Image options
                    </Button>
                  )}
                  {queued.length > 0 && (
                    <span className="flex h-8 items-center rounded-full border border-neutral-800 px-2.5 text-[11px] text-neutral-400">
                      {queued.length} queued
                    </span>
                  )}
                  </div>

                  <div className="flex items-center gap-1.5">
                    {!voiceMode && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={toggleRecording}
                          disabled={transcribing}
                          className={`size-8 ${recording ? 'border-red-500/50 text-red-400' : ''}`}
                        >
                          {transcribing ? (
                            <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                          ) : recording ? (
                            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                          ) : (
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-14 0m7 7v3m0-3a4 4 0 01-4-4V5a4 4 0 018 0v6a4 4 0 01-4 4z" /></svg>
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{recording ? 'Stop recording' : 'Record voice'}</TooltipContent>
                    </Tooltip>
                    )}
                    {messages.some(m => m.streaming) && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            onClick={() => { const s = messages.find(m => m.streaming); if (s) window.api.cancelRag?.(s.id); }}
                            className="size-8 rounded-full border-red-500/50 text-red-400 hover:bg-red-500/10"
                          >
                            <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Stop generating</TooltipContent>
                      </Tooltip>
                    )}
                    {loading && mode === 'image' ? (
                      <Button type="button" variant="outline" onClick={() => window.api.cancelImageGen?.()} className="h-8 gap-1.5 border-red-500/50 text-red-400 hover:bg-red-500/10">
                        <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                        Stop
                      </Button>
                    ) : voiceMode ? null : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            size="icon"
                            onClick={() => sendMessage()}
                            disabled={!input.trim() && attachments.length === 0}
                            className="size-8 rounded-full"
                          >
                            {/* Always sendable — generating doesn't block; messages queue. */}
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" /></svg>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Send</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Canvas — sandboxed render of a model-generated artifact */}
      {canvasArtifact && <ArtifactCanvas artifact={canvasArtifact} onClose={() => setCanvasArtifact(null)} width={canvasWidth} onResize={setCanvasWidth} />}

      {/* Skills — view / create / edit reusable instruction packs */}
      {skillsOpen && <SkillsPanel onClose={() => setSkillsOpen(false)} onChanged={() => window.api.listSkills?.().then(s => setSkills(s || [])).catch(() => {})} />}

      {/* Settings — model params, voice, tools, connectors */}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {modelPickerOpen && <ModelPicker onClose={() => setModelPickerOpen(false)} />}

      {/* Text viewer — expand a pasted/attached file's full content */}
      {viewer && (
        <div className="fixed right-0 top-0 bottom-0 z-50 flex w-[30vw] min-w-[420px] flex-col border-l border-neutral-800 bg-neutral-950 font-mono shadow-2xl">
          <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
            <span className="truncate text-sm text-neutral-200">{viewer.title}</span>
            <button onClick={() => setViewer(null)} className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-300 transition-colors hover:text-white">Close</button>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-4 text-xs leading-relaxed text-neutral-300">{viewer.text}</pre>
        </div>
      )}

      {/* Lightbox — click a generated image to enlarge, download, or delete */}
      {lightbox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-10" onClick={() => setLightbox(null)}>
          <div className="absolute right-4 top-4 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            {lightbox.path && (
              <>
                <button
                  onClick={() => downloadImage(lightbox.path, lightbox.path?.split('/').pop())}
                  className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 transition-colors hover:border-green-500 hover:text-green-500"
                >
                  Download
                </button>
                <button
                  onClick={() => deleteImage(lightbox.path)}
                  className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 transition-colors hover:border-red-500 hover:text-red-400"
                >
                  Delete
                </button>
              </>
            )}
            <button
              onClick={() => setLightbox(null)}
              className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 transition-colors hover:text-white"
            >
              Close
            </button>
          </div>
          <img src={lightbox.url} alt="" className="max-h-full max-w-full rounded-md object-contain" onClick={(e) => e.stopPropagation()} />
        </div>
      )}

      {/* Gallery — everything generated on-device: images + artifacts */}
      {showGallery && (
        <>
          <div className="fixed right-0 top-0 bottom-0 z-50 flex w-[30vw] min-w-[420px] flex-col border-l border-neutral-800 bg-neutral-950 font-mono shadow-2xl">
            <div className="flex items-center justify-between border-b border-neutral-900 px-4 py-3">
              <span className="text-sm text-neutral-200">Gallery</span>
              <button onClick={() => setShowGallery(false)} className="text-neutral-500 transition-colors hover:text-neutral-200">✕</button>
            </div>
            <div className="flex items-center gap-1 border-b border-neutral-900 px-3 py-2">
              {(['images', 'artifacts'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setGalleryTab(tab)}
                  className={`rounded px-3 py-1 text-xs capitalize transition-colors ${galleryTab === tab ? 'bg-neutral-800 text-green-500' : 'text-neutral-500 hover:text-neutral-300'}`}
                >
                  {tab} {tab === 'images' ? `(${gallery.length})` : `(${artifacts.length})`}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 border-b border-neutral-900 px-3 py-1.5">
              {(['chat', 'project', 'all'] as const).map(sc => (
                <button
                  key={sc}
                  onClick={() => setGalleryScope(sc)}
                  disabled={sc === 'project' && !activeProjectId}
                  className={`rounded px-2 py-0.5 text-[10px] capitalize transition-colors disabled:opacity-30 ${galleryScope === sc ? 'bg-neutral-800 text-green-500' : 'text-neutral-500 hover:text-neutral-300'}`}
                >
                  {sc === 'chat' ? 'This chat' : sc}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {galleryTab === 'images' ? (
                gallery.length === 0 ? (
                  <p className="py-10 text-center text-xs text-neutral-600">No images generated yet.</p>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {gallery.map((g) => (
                      <button
                        key={g.path}
                        onClick={() => setLightbox({ url: `ogcapture://${g.path}`, path: g.path })}
                        className="overflow-hidden rounded-md border border-neutral-800 transition-colors hover:border-green-500"
                      >
                        <img src={`ogcapture://${g.path}`} alt="" className="aspect-square w-full object-cover" />
                      </button>
                    ))}
                  </div>
                )
              ) : (
                <>
                  {artifacts.length === 0 ? (
                    <p className="py-10 text-center text-xs text-neutral-600">No artifacts in this {galleryScope === 'all' ? 'app' : galleryScope}.</p>
                  ) : (
                <div className="flex flex-col gap-2">
                  {artifacts.map((a) => (
                    <div key={a.id} className="group flex items-center gap-2 rounded-md border border-neutral-800 p-2 transition-colors hover:border-green-500">
                      <button
                        onClick={() => a.kind === 'image'
                          ? (closePanels(), setLightbox({ url: `ogcapture://${a.code}`, path: a.code }))
                          : a.kind === 'text'
                            ? (closePanels(), setViewer({ title: a.title, text: a.code }))
                            : openCanvas({ kind: a.kind, code: a.code, title: a.title })}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        {a.kind === 'image' ? (
                          <img src={`ogcapture://${a.code}`} alt="" className="h-8 w-8 shrink-0 rounded-sm border border-neutral-800 object-cover" />
                        ) : (
                          <span className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-green-500">{a.kind === 'text' ? 'input' : a.kind}</span>
                        )}
                        <span className="truncate text-xs text-neutral-200">{a.title}</span>
                      </button>
                      <button onClick={() => deleteArtifact(a.id)} className="text-neutral-600 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100" title="Delete">✕</button>
                    </div>
                  ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
