
import { ChatList } from './components/ChatList';
import { ChatDetail } from './components/ChatDetail';
import { CommandPalette } from './components/CommandPalette';
import logo from './assets/logo.png';
import { useMeetingRecorder } from './useMeetingRecorder';
import { MemoryChat } from './components/MemoryChat';
import { Settings } from './components/Settings';
import { ModelsScreen } from './components/ModelsScreen';
import { ProjectsScreen } from './components/ProjectsScreen';
import { ConnectorsScreen } from './components/ConnectorsScreen';
import { GatewayScreen } from './components/GatewayScreen';
import { Onboarding } from './components/Onboarding';
import { PermissionGate } from './components/PermissionGate';
import type { SearchHit } from './types';
// Open-core: pro screens live in the private pro package and render through the
// pro view-router; the free build shows the UpgradeScreen for those tabs.
import { loadProFeaturesRenderer } from './bootstrap/loadProFeaturesRenderer';
import { renderProView, type ProViewContext } from './bootstrap/proView';
import { UpgradeScreen } from './components/pro/UpgradeScreen';
import { getProFeature } from './components/pro/proCatalog';
import { NotificationProvider, useNotifications } from './hooks/useNotifications';
import { ReprocessingProvider, useReprocessing } from './hooks/useReprocessing';
import { useState, useEffect, useCallback, useRef } from 'react';
import { StarsBackground } from './components/ui/stars-background';
import { ShootingStars } from './components/ui/shooting-stars';
import { Sidebar, SidebarBody } from './components/ui/sidebar';
import { motion, AnimatePresence } from 'motion/react';
import {
  IconMessageCircle,
  IconSettings,
  IconDownload,
  IconFolders,
  IconPlug,
  IconServer2,
  IconLock,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconLoader2,
  IconArrowLeft,
  IconArrowRight
} from '@tabler/icons-react';
import { cn } from './lib/utils';
import { usePostHog } from 'posthog-js/react';

type ViewMode = 'dashboard' | 'day' | 'replay' | 'reflect' | 'actions' | 'connectors' | 'meetings' | 'chats' | 'memories' | 'entities' | 'graph' | 'memory-chat' | 'models' | 'gateway' | 'projects' | 'notifications' | 'settings' | 'search';

// Navigation state type for history tracking
interface NavigationState {
  viewMode: ViewMode;
  selectedSessionId: string | null;
  selectedMemoryId: number | null;
  selectedEntityId: number | null;
}

function ReprocessingBanner() {
  const { reprocessing, progress } = useReprocessing();
  if (!reprocessing) return null;

  const pct = progress && progress.total > 0
    ? Math.round((progress.processed / progress.total) * 100)
    : 0;

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.3 }}
      className="bg-neutral-900/90 backdrop-blur-sm border-b border-neutral-800 px-4 py-2 flex items-center gap-3"
    >
      <motion.div
        className="w-3.5 h-3.5 border-2 border-neutral-400 border-t-transparent rounded-full shrink-0"
        animate={{ rotate: 360 }}
        transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
      />
      <span className="text-sm text-neutral-400 flex-1 min-w-0 truncate">
        {progress?.phase === 'cleared'
          ? 'Data cleared. Rebuilding memories and entities...'
          : progress
            ? `Reprocessing session ${progress.processed} of ${progress.total}...`
            : 'Reprocessing sessions...'}
      </span>
      {progress && progress.total > 0 && (
        <div className="w-24 h-1.5 bg-neutral-800 rounded-full overflow-hidden shrink-0">
          <motion.div
            className="h-full bg-neutral-500 rounded-full"
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.3 }}
          />
        </div>
      )}
      {progress && progress.total > 0 && (
        <span className="text-xs text-neutral-600 shrink-0">{pct}%</span>
      )}
    </motion.div>
  );
}

function AppContent() {

  const posthog = usePostHog()
  const { addNotification } = useNotifications();

  // Pro entitlement (preload reads OFFGRID_PRO; absent submodule => false at runtime).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isPro = !!(window as any).api?.isPro;
  // Re-render once pro renderer features have activated (registers the view-router).
  const [, setProReady] = useState(false);
  useEffect(() => {
    let mounted = true;
    void loadProFeaturesRenderer().finally(() => { if (mounted) setProReady(true); });
    return () => { mounted = false; };
  }, []);

  // Free users land on Models (download a model first, with the sidebar to
  // explore); pro lands on Day. Never a locked Pro tab.
  const [viewMode, setViewMode] = useState<ViewMode>(isPro ? 'day' : 'models');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedMemoryId, setSelectedMemoryId] = useState<number | null>(null);
  const [selectedEntityId, setSelectedEntityId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [replayTarget, setReplayTarget] = useState<number | null>(null);
  // A search hit can deep-link to a specific meeting; cleared on leaving Meetings.
  const [meetingTarget, setMeetingTarget] = useState<number | null>(null);
  // Which tab the Actions screen opens on when reached via a Day "View all" link.
  const [actionsMode, setActionsMode] = useState<'todo' | 'approvals' | null>(null);
  // Target chat to open in the main Chat screen (from the Projects tab): an
  // existing conversation, or a request to start a new chat scoped to a project.
  const [chatTarget, setChatTarget] = useState<{ conversationId?: string; projectId?: string } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [meetingPlatform, setMeetingPlatform] = useState<string | null>(null);
  const rec = useMeetingRecorder();

  // Proactive: a Zoom/Meet/Teams call detected → AUTO-record (visible indicator
  // in-app + menu bar keeps it transparent).
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).api;
    const offDetected = api.onMeetingDetected?.((platform: string) => {
      setMeetingPlatform(platform);
      rec.start(platform);
    });
    const offEnded = api.onMeetingEnded?.(() => {
      setMeetingPlatform(null);
      rec.stop(); // call ended → finish + transcribe
    });
    const offStop = api.onMeetingStop?.(() => rec.stop()); // from the menu-bar tray
    // Catch a call that was ALREADY in progress when this window loaded — the
    // detector's edge broadcast can fire before the renderer is listening, so we
    // ask main for the current state once on mount and auto-record if active.
    void (async () => {
      try {
        const st = await api.meetingGetState?.();
        if (st?.active && !rec.recording) {
          setMeetingPlatform(st.platform ?? 'meeting');
          rec.start(st.platform ?? undefined);
        }
      } catch { /* ignore */ }
    })();
    return () => { offDetected?.(); offEnded?.(); offStop?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror recording state to main so the menu-bar tray can show it.
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).api.meetingSetRecording?.(rec.recording);
  }, [rec.recording]);

  // Tell the capture layer which screen is showing, so self-capture can skip the
  // memory-mirror views (Day/Replay/Entities/…) and avoid looping the graph.
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window.api as any)?.reportSelfView?.(viewMode);
  }, [viewMode]);

  // Navigation history stacks (back and forward)
  const navigationHistory = useRef<NavigationState[]>([]);
  const forwardHistory = useRef<NavigationState[]>([]);
  const isNavigatingHistory = useRef(false);
  // Reactive mirrors of the stacks so the in-app back/forward buttons can
  // enable/disable (refs alone don't trigger a re-render).
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const syncNavFlags = useCallback(() => {
    setCanGoBack(navigationHistory.current.length > 1);
    setCanGoForward(forwardHistory.current.length > 0);
  }, []);


  // Handle browser URL changes
  useEffect(() => {
    const path = window.location.pathname;
    const viewMap: Record<string, ViewMode> = {
      '/': 'day',
      '/day': 'day',
      '/replay': 'replay',
      '/reflect': 'reflect',
      '/actions': 'actions',
      '/connectors': 'connectors',
      '/meetings': 'meetings',
      '/chat': 'memory-chat',
      '/chats': 'chats',
      '/memories': 'memories',
      '/entities': 'entities',
      '/graph': 'graph',
      '/models': 'models',
      '/gateway': 'gateway',
      '/projects': 'projects',
      '/notifications': 'notifications',
      '/search': 'search',
      '/settings': 'settings'
    };

    if (viewMap[path]) {
      setViewMode(viewMap[path]);
    }
  }, []);

  // Update browser URL when view mode changes
  useEffect(() => {
    const urlMap: Record<ViewMode, string> = {
      'day': '/day',
      'replay': '/replay',
      'reflect': '/reflect',
      'actions': '/actions',
      'connectors': '/connectors',
      'meetings': '/meetings',
      'dashboard': '/dashboard',
      'memory-chat': '/chat',
      'chats': '/chats',
      'memories': '/memories',
      'entities': '/entities',
      'graph': '/graph',
      'models': '/models',
      'gateway': '/gateway',
      'projects': '/projects',
      'notifications': '/notifications',
      'search': '/search',
      'settings': '/settings'
    };

    const newPath = urlMap[viewMode];
    if (window.location.pathname !== newPath) {
      window.history.replaceState(null, '', newPath);
    }
  }, [viewMode]);

  // Track navigation state changes and push to history (except when navigating back/forward)
  useEffect(() => {
    if (isNavigatingHistory.current) {
      isNavigatingHistory.current = false;
      return;
    }

    // Avoid duplicating the same state
    const currentState: NavigationState = {
      viewMode,
      selectedSessionId,
      selectedMemoryId,
      selectedEntityId
    };

    const lastState = navigationHistory.current[navigationHistory.current.length - 1];
    const isSameState = lastState &&
      lastState.viewMode === currentState.viewMode &&
      lastState.selectedSessionId === currentState.selectedSessionId &&
      lastState.selectedMemoryId === currentState.selectedMemoryId &&
      lastState.selectedEntityId === currentState.selectedEntityId;

    if (!isSameState) {
      navigationHistory.current.push(currentState);
      // Clear forward history when navigating to a new state
      forwardHistory.current = [];
      // Limit history size to prevent memory issues
      if (navigationHistory.current.length > 50) {
        navigationHistory.current = navigationHistory.current.slice(-50);
      }
    }
    syncNavFlags();
  }, [viewMode, selectedSessionId, selectedMemoryId, selectedEntityId, syncNavFlags]);

  // Subscribe to notification events from the main process
  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    // Proactive approval queued — needs the user's decision
    if (window.api?.onNewApproval) {
      const unsubscribe = window.api.onNewApproval((data) => {
        addNotification({
          type: 'approval',
          title: data.entityName ? `Approval — ${data.entityName}` : 'Approval needed',
          message: data.detail ? `${data.title} — ${data.detail}` : data.title,
          approvalId: data.approvalId,
        });
      });
      unsubscribers.push(unsubscribe);
    }

    // New to-do extracted from your activity
    if (window.api?.onNewAction) {
      const unsubscribe = window.api.onNewAction((data) => {
        const where = [data.entityName, data.sourceApp].filter(Boolean).join(' · ');
        addNotification({
          type: 'todo',
          title: data.due ? `New to-do — due ${data.due}` : 'New to-do',
          message: where ? `${data.text} (${where})` : data.text,
          actionId: data.actionId,
        });
      });
      unsubscribers.push(unsubscribe);
    }

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [addNotification]);

  // Navigate back using history stack
  const navigateBack = useCallback(() => {
    if (navigationHistory.current.length > 1) {
      isNavigatingHistory.current = true;
      // Pop current state and push to forward history
      const currentState = navigationHistory.current.pop();
      if (currentState) {
        forwardHistory.current.push(currentState);
      }
      // Get previous state
      const previousState = navigationHistory.current[navigationHistory.current.length - 1];
      if (previousState) {
        setViewMode(previousState.viewMode);
        setSelectedSessionId(previousState.selectedSessionId);
        setSelectedMemoryId(previousState.selectedMemoryId);
        setSelectedEntityId(previousState.selectedEntityId);
      }
      syncNavFlags();
    }
  }, [syncNavFlags]);

  // Navigate forward using forward history stack
  const navigateForward = useCallback(() => {
    if (forwardHistory.current.length > 0) {
      isNavigatingHistory.current = true;
      // Pop from forward history
      const nextState = forwardHistory.current.pop();
      if (nextState) {
        // Push to back history
        navigationHistory.current.push(nextState);
        // Apply the state
        setViewMode(nextState.viewMode);
        setSelectedSessionId(nextState.selectedSessionId);
        setSelectedMemoryId(nextState.selectedMemoryId);
        setSelectedEntityId(nextState.selectedEntityId);
      }
      syncNavFlags();
    }
  }, [syncNavFlags]);

  const handleBack = useCallback(() => {
    navigateBack();
  }, [navigateBack]);

  // Navigation handlers for Dashboard and MemoryChat
  const handleSelectChat = useCallback((sessionId: string) => {
    setViewMode('chats');
    setSelectedSessionId(sessionId);
  }, []);

  const handleSelectMemory = useCallback((memoryId: number) => {
    setViewMode('memories');
    setSelectedMemoryId(memoryId);
  }, []);

  const handleSelectEntity = useCallback((entityId: number) => {
    setViewMode('entities');
    setSelectedEntityId(entityId);
  }, []);

  // Universal-search result → jump to the exact thing: open its source URL, the
  // owning entity/memory/meeting, or seek Replay to that captured moment.
  const handleOpenHit = useCallback((hit: SearchHit) => {
    if (hit.kind === 'entity' || hit.kind === 'fact') { handleSelectEntity(hit.refId); return; }
    if (hit.kind === 'memory') { handleSelectMemory(hit.refId); return; }
    if (hit.kind === 'meeting') { setMeetingTarget(hit.refId || null); setViewMode('meetings'); return; }
    // Screen capture → seek Replay to that exact moment (the captured frame is the
    // point; the source URL may be stale/missing).
    setReplayTarget(hit.ts || Date.now());
    setViewMode('replay');
  }, [handleSelectEntity, handleSelectMemory]);

  const openSearch = useCallback((q: string) => { setSearchQuery(q); setViewMode('search'); }, []);

  // Deep-link targets (Replay moment, specific meeting) are one-shot: once we've
  // left the screen that consumes them, clear them so a later normal visit isn't
  // pinned to a stale moment. Covers every exit path (nav, back/forward, deep-link).
  useEffect(() => {
    if (viewMode !== 'replay' && replayTarget !== null) setReplayTarget(null);
    if (viewMode !== 'meetings' && meetingTarget !== null) setMeetingTarget(null);
    if (viewMode !== 'actions' && actionsMode !== null) setActionsMode(null);
  }, [viewMode, replayTarget, meetingTarget, actionsMode]);

  // Open a project chat in the main Chat screen (existing convo or new-in-project).
  const handleOpenProjectChat = useCallback((target: { conversationId?: string; projectId?: string }) => {
    setChatTarget(target);
    setViewMode('memory-chat');
  }, []);

  // Global keyboard shortcuts for back/forward navigation (Cmd+[ and Cmd+])
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '[') {
        e.preventDefault();
        navigateBack();
      } else if ((e.metaKey || e.ctrlKey) && e.key === ']') {
        e.preventDefault();
        navigateForward();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigateBack, navigateForward]);

  // Original sidebar order preserved. Pro tabs pull their icon/label from the
  // static catalogue and are marked locked in the free build (open the
  // UpgradeScreen); core tabs (Projects / Chat / Models / Settings) sit where
  // they always did.
  const proItem = (route: string): { label: string; icon: React.ReactNode; view: ViewMode; locked: boolean } => {
    const f = getProFeature(route)!;
    return {
      label: f.label,
      icon: <f.icon className="h-5 w-5 shrink-0 text-neutral-400" weight="regular" />,
      view: f.route as ViewMode,
      locked: !isPro,
    };
  };
  // Icons take no color — the nav button drives it (emerald when active).
  const mainNav: { label: string; icon: React.ReactNode; view: ViewMode; locked?: boolean }[] = [
    proItem('search'),
    proItem('day'),
    proItem('replay'),
    proItem('reflect'),
    proItem('meetings'),
    proItem('actions'),
    proItem('entities'),
    { label: 'Projects', icon: <IconFolders className="h-5 w-5 shrink-0" />, view: 'projects' as ViewMode },
    { label: 'Chat', icon: <IconMessageCircle className="h-5 w-5 shrink-0" />, view: 'memory-chat' as ViewMode },
    { label: 'Integrations', icon: <IconPlug className="h-5 w-5 shrink-0" />, view: 'connectors' as ViewMode },
    { label: 'Models', icon: <IconDownload className="h-5 w-5 shrink-0" />, view: 'models' as ViewMode },
    { label: 'Gateway', icon: <IconServer2 className="h-5 w-5 shrink-0" />, view: 'gateway' as ViewMode },
    proItem('notifications'),
  ];
  const bottomNav: { label: string; icon: React.ReactNode; view: ViewMode; locked?: boolean }[] = [
    { label: 'Settings', icon: <IconSettings className="h-5 w-5 shrink-0" />, view: 'settings' as ViewMode },
  ];
  const renderNavItem = (item: { label: string; icon: React.ReactNode; view: ViewMode; locked?: boolean }): React.ReactElement => {
    const active = viewMode === item.view;
    return (
      <button
        key={item.view}
        onClick={() => {
          posthog.capture('button_clicked', { button_name: 'navigation_' + item.view })
          setViewMode(item.view); setSelectedSessionId(null); setSelectedMemoryId(null); setSelectedEntityId(null); setReplayTarget(null);
        }}
        title={!sidebarOpen ? item.label : undefined}
        className={cn(
          'group/nav relative flex items-center gap-3 rounded-lg py-2 text-sm transition-colors',
          sidebarOpen ? 'px-3' : 'justify-center px-0',
          active
            ? 'bg-green-500/10 text-green-600 dark:text-green-400'
            : 'text-neutral-500 hover:bg-neutral-500/10 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white'
        )}
      >
        {active && <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-green-500" />}
        {item.icon}
        {sidebarOpen && <span className="flex-1 text-left whitespace-pre">{item.label}</span>}
        {sidebarOpen && item.locked && <IconLock className="h-3.5 w-3.5 shrink-0 text-neutral-400/60" title="Pro" />}
      </button>
    );
  };

  return (
    <div className="h-screen w-full overflow-hidden bg-neutral-950 relative">
      <CommandPalette onOpenHit={handleOpenHit} onSeeAll={openSearch} />
      {/* Recording indicator — auto-records detected meetings; always visible. */}
      {(rec.recording || rec.busy) && (
        <button
          onClick={() => rec.recording && rec.stop()}
          className="absolute left-1/2 top-4 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-red-500/40 bg-neutral-900/95 px-3.5 py-1.5 font-mono text-xs text-neutral-200 shadow-xl backdrop-blur hover:border-red-500"
        >
          {rec.busy ? (
            <><IconLoader2 className="h-3.5 w-3.5 animate-spin text-neutral-400" /> Transcribing meeting…</>
          ) : (
            <>
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
              Recording {meetingPlatform === 'zoom' ? 'Zoom' : meetingPlatform === 'teams' ? 'Teams' : meetingPlatform === 'meet' ? 'Meet' : 'meeting'} · {Math.floor(rec.elapsed / 60)}:{String(rec.elapsed % 60).padStart(2, '0')} · click to stop
            </>
          )}
        </button>
      )}
      {/* Background effects */}
      <StarsBackground className="absolute inset-0 z-0" />
      <ShootingStars />

      <div className="flex h-full relative z-10">
        {/* Aceternity Sidebar */}
        <Sidebar open={sidebarOpen} setOpen={setSidebarOpen}>
          <SidebarBody className="justify-between gap-3 bg-neutral-900/80 backdrop-blur-xl border-r border-neutral-800">
            <div className="flex min-h-0 flex-1 flex-col">
              {/* Brand + a dedicated collapse/expand toggle */}
              {sidebarOpen ? (
                <div className="flex items-center gap-2 py-2">
                  <img src={logo} alt="Off Grid" className="h-8 w-8 shrink-0 rounded-lg" />
                  <span className="flex-1 text-left font-semibold text-white whitespace-pre">Off Grid AI</span>
                  <button
                    onClick={() => setSidebarOpen(false)}
                    aria-label="Collapse sidebar"
                    title="Collapse"
                    className="shrink-0 rounded-lg p-1.5 text-neutral-400 transition-colors hover:bg-neutral-800/60 hover:text-white"
                  >
                    <IconLayoutSidebarLeftCollapse className="h-5 w-5" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setSidebarOpen(true)}
                  aria-label="Expand sidebar"
                  title="Expand"
                  className="group/exp flex w-full flex-col items-center gap-1 py-2"
                >
                  <img src={logo} alt="Off Grid" className="h-8 w-8 shrink-0 rounded-lg" />
                  <IconLayoutSidebarLeftExpand className="h-4 w-4 text-neutral-500 transition-colors group-hover/exp:text-white" />
                </button>
              )}

              {/* Back / forward — a distinct control (filled), available everywhere (⌘[ / ⌘]) */}
              <div className={cn('mt-3 flex items-center gap-1', !sidebarOpen && 'justify-center')}>
                <button
                  onClick={navigateBack}
                  disabled={!canGoBack}
                  aria-label="Back"
                  title="Back (⌘[)"
                  className={cn(
                    'flex items-center justify-center gap-1.5 rounded-lg border border-neutral-800 bg-neutral-800/40 text-neutral-300 transition-colors hover:border-neutral-700 hover:bg-neutral-800 hover:text-white disabled:opacity-30 disabled:hover:bg-neutral-800/40',
                    sidebarOpen ? 'flex-1 px-2 py-1.5' : 'h-9 w-9'
                  )}
                >
                  <IconArrowLeft className="h-4 w-4 shrink-0" />
                  {sidebarOpen && <span className="text-xs font-medium">Back</span>}
                </button>
                {sidebarOpen && (
                  <button
                    onClick={navigateForward}
                    disabled={!canGoForward}
                    aria-label="Forward"
                    title="Forward (⌘])"
                    className="flex items-center justify-center rounded-lg border border-neutral-800 bg-neutral-800/40 px-2 py-1.5 text-neutral-300 transition-colors hover:border-neutral-700 hover:bg-neutral-800 hover:text-white disabled:opacity-30 disabled:hover:bg-neutral-800/40"
                  >
                    <IconArrowRight className="h-4 w-4 shrink-0" />
                  </button>
                )}
              </div>

              {/* Navigation (scrolls; Settings is pinned to the bottom) */}
              <div className="mt-6 flex flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden pr-0.5">
                {mainNav.map(renderNavItem)}
              </div>
            </div>

            {/* Pinned bottom */}
            <div className="flex flex-col gap-1 border-t border-neutral-200 pt-2 dark:border-neutral-800">
              {bottomNav.map(renderNavItem)}
            </div>
          </SidebarBody>
        </Sidebar>

        {/* Main Content */}
        <div className="flex-1 flex flex-col h-full overflow-hidden">
          {/* Global reprocessing banner */}
          <AnimatePresence>
            <ReprocessingBanner />
          </AnimatePresence>
          {/* Content Area */}
          <div className="flex-1 overflow-hidden">
            <AnimatePresence mode="wait">
              {viewMode === 'chats' && selectedSessionId ? (
                <motion.div
                  key={`chat-detail-${selectedSessionId}`}
                  initial={{ opacity: 0, filter: 'blur(10px)' }}
                  animate={{ opacity: 1, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, filter: 'blur(5px)' }}
                  transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
                  className="h-full"
                >
                  <ChatDetail
                    sessionId={selectedSessionId}
                    onBack={handleBack}
                    onSelectEntity={(entityId) => {
                      setSelectedEntityId(entityId);
                      setViewMode('entities');
                      setSelectedSessionId(null);
                    }}
                    onSelectMemory={(memoryId) => {
                      setSelectedMemoryId(memoryId);
                      setViewMode('memories');
                      setSelectedSessionId(null);
                    }}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key={viewMode}
                  initial={{ opacity: 0, filter: 'blur(10px)' }}
                  animate={{ opacity: 1, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, filter: 'blur(5px)' }}
                  transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
                  className="p-6 h-full overflow-y-auto"
                >
                  {viewMode === 'memory-chat' ? (
                    <MemoryChat
                      onNavigateToMemory={handleSelectMemory}
                      onNavigateToChat={handleSelectChat}
                      onNavigateToEntity={handleSelectEntity}
                      openTarget={chatTarget}
                      onTargetConsumed={() => setChatTarget(null)}
                    />
                  ) : viewMode === 'chats' ? (
                    <ChatList onSelectSession={setSelectedSessionId} />
                  ) : viewMode === 'models' ? (
                    <ModelsScreen />
                  ) : viewMode === 'projects' ? (
                    <ProjectsScreen onOpenChat={handleOpenProjectChat} />
                  ) : viewMode === 'connectors' ? (
                    <ConnectorsScreen />
                  ) : viewMode === 'gateway' ? (
                    <GatewayScreen />
                  ) : viewMode === 'settings' ? (
                    <Settings />
                  ) : (
                    // Pro tabs: render through the pro view-router when active,
                    // otherwise show the upgrade writeup for that feature.
                    renderProView(viewMode, {
                      setView: (v) => setViewMode(v as ViewMode),
                      replayTarget,
                      meetingTarget,
                      actionsMode,
                      setActionsMode,
                      searchQuery,
                      selectedMemoryId,
                      setSelectedMemoryId,
                      rec,
                      onSelectEntity: handleSelectEntity,
                      onSelectMemory: handleSelectMemory,
                      onOpenHit: handleOpenHit,
                    } satisfies ProViewContext) ?? <UpgradeScreen feature={getProFeature(viewMode)} />
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  // Onboarding runs FIRST — before the model/permission gate — so a new user sees
  // the intro, then goes straight to model selection (handled by PermissionGate).
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  useEffect(() => {
    setOnboarded(localStorage.getItem('onboarding_completed') === 'true');
  }, []);

  if (onboarded === null) return null;
  if (!onboarded) return <Onboarding onComplete={() => setOnboarded(true)} />;

  return (
    <PermissionGate>
      <NotificationProvider>
        <ReprocessingProvider>
          <AppContent />
        </ReprocessingProvider>
      </NotificationProvider>
    </PermissionGate>
  );
}

export default App;
