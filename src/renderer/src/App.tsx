
import { ChatList } from './components/ChatList';
import { ChatDetail } from './components/ChatDetail';
import { MemoryList } from './components/MemoryList';
import { EntityList } from './components/EntityList';
import { EntitiesScreen } from './components/EntitiesScreen';
import { SearchScreen, type SearchHit } from './components/SearchScreen';
import { CommandPalette } from './components/CommandPalette';
import logo from './assets/logo.png';
import { useMeetingRecorder } from './useMeetingRecorder';
import { DayView } from './components/DayView';
import { ReplayScreen } from './components/ReplayScreen';
import { ReflectScreen } from './components/ReflectScreen';
import { ActionsScreen } from './components/ActionsScreen';
import { ConnectorsScreen } from './components/ConnectorsScreen';
import { MeetingsScreen } from './components/MeetingsScreen';
import { EntityGraph } from './components/EntityGraph';
import { MemoryChat } from './components/MemoryChat';
import { Settings } from './components/Settings';
import { ModelsScreen } from './components/ModelsScreen';
import { ProjectsScreen } from './components/ProjectsScreen';
import { Onboarding } from './components/Onboarding';
import { NotificationList } from './components/NotificationList';
import { PermissionGate } from './components/PermissionGate';
import { NotificationProvider, useNotifications } from './hooks/useNotifications';
import { ReprocessingProvider, useReprocessing } from './hooks/useReprocessing';
import { useState, useEffect, useCallback, useRef } from 'react';
import { StarsBackground } from './components/ui/stars-background';
import { ShootingStars } from './components/ui/shooting-stars';
import { Sidebar, SidebarBody } from './components/ui/sidebar';
import { motion, AnimatePresence } from 'motion/react';
import {
  IconMessageCircle,
  IconMessages,
  IconBrain,
  IconUsers,
  IconGraph,
  IconSparkles,
  IconBell,
  IconSettings,
  IconDownload,
  IconFolders,
  IconCalendar,
  IconSearch,
  IconMovie,
  IconChartPie,
  IconChecklist,
  IconPlug,
  IconChevronLeft,
  IconVideo,
  IconLoader2
} from '@tabler/icons-react';
import { cn } from './lib/utils';
import { usePostHog } from 'posthog-js/react';

type ViewMode = 'dashboard' | 'day' | 'replay' | 'reflect' | 'actions' | 'connectors' | 'meetings' | 'chats' | 'memories' | 'entities' | 'graph' | 'memory-chat' | 'models' | 'projects' | 'notifications' | 'settings' | 'search';

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
  const { addNotification, unreadCount } = useNotifications();
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState<boolean | null>(null);

  const [viewMode, setViewMode] = useState<ViewMode>('day');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedMemoryId, setSelectedMemoryId] = useState<number | null>(null);
  const [selectedEntityId, setSelectedEntityId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [replayTarget, setReplayTarget] = useState<number | null>(null);
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

  // Navigation history stacks (back and forward)
  const navigationHistory = useRef<NavigationState[]>([]);
  const forwardHistory = useRef<NavigationState[]>([]);
  const isNavigatingHistory = useRef(false);

  // Check onboarding status on mount
  useEffect(() => {
    const completed = localStorage.getItem('onboarding_completed') === 'true';
    setHasCompletedOnboarding(completed);
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
  }, [viewMode, selectedSessionId, selectedMemoryId, selectedEntityId]);

  // Subscribe to notification events from the main process
  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    // New messages notification
    if (window.api?.onNewMessages) {
      const unsubscribe = window.api.onNewMessages((data) => {
        addNotification({
          type: 'chat',
          title: `New messages in ${data.appName}`,
          message: `${data.count} new message${data.count > 1 ? 's' : ''} in "${data.chatTitle}"`,
          sessionId: data.sessionId,
        });
      });
      unsubscribers.push(unsubscribe);
    }

    // New memory notification
    if (window.api?.onNewMemory) {
      const unsubscribe = window.api.onNewMemory((data) => {
        addNotification({
          type: 'memory',
          title: 'New memory stored',
          message: data.memoryContent,
          sessionId: data.sessionId || undefined,
        });
      });
      unsubscribers.push(unsubscribe);
    }

    // New entity notification
    if (window.api?.onNewEntity) {
      const unsubscribe = window.api.onNewEntity((data) => {
        addNotification({
          type: 'entity',
          title: `New entity: ${data.entityName}`,
          message: `${data.entityType} with ${data.factsCount} fact${data.factsCount > 1 ? 's' : ''} discovered`,
          entityId: data.entityId,
        });
      });
      unsubscribers.push(unsubscribe);
    }

    // Summary generated notification
    if (window.api?.onSummaryGenerated) {
      const unsubscribe = window.api.onSummaryGenerated((data) => {
        addNotification({
          type: 'summary',
          title: 'Chat summary generated',
          message: `Summary created for "${data.chatTitle}"`,
          sessionId: data.sessionId,
        });
      });
      unsubscribers.push(unsubscribe);
    }

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [addNotification]);

  const handleOnboardingComplete = () => {
    setHasCompletedOnboarding(true);
  };

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
    }
  }, []);

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
    }
  }, []);

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
    if (hit.url) { window.open(hit.url, '_blank'); return; }
    if (hit.kind === 'entity' || hit.kind === 'fact') { handleSelectEntity(hit.refId); return; }
    if (hit.kind === 'memory') { handleSelectMemory(hit.refId); return; }
    if (hit.kind === 'meeting') { setViewMode('meetings'); return; }
    setReplayTarget(hit.ts || null); // screen capture → seek Replay to that frame
    setViewMode('replay');
  }, [handleSelectEntity, handleSelectMemory]);

  const openSearch = useCallback((q: string) => { setSearchQuery(q); setViewMode('search'); }, []);

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

  // Show loading state while checking onboarding status
  if (hasCompletedOnboarding === null) {
    return null;
  }

  // Show onboarding if not completed
  if (!hasCompletedOnboarding) {
    return <Onboarding onComplete={handleOnboardingComplete} />;
  }

  const navItems = [
    { label: 'Search', icon: <IconSearch className="h-5 w-5 shrink-0 text-neutral-400" />, view: 'search' as ViewMode },
    { label: 'Day', icon: <IconCalendar className="h-5 w-5 shrink-0 text-neutral-400" />, view: 'day' as ViewMode },
    { label: 'Replay', icon: <IconMovie className="h-5 w-5 shrink-0 text-neutral-400" />, view: 'replay' as ViewMode },
    { label: 'Reflect', icon: <IconChartPie className="h-5 w-5 shrink-0 text-neutral-400" />, view: 'reflect' as ViewMode },
    { label: 'Meetings', icon: <IconVideo className="h-5 w-5 shrink-0 text-neutral-400" />, view: 'meetings' as ViewMode },
    { label: 'Actions', icon: <IconChecklist className="h-5 w-5 shrink-0 text-neutral-400" />, view: 'actions' as ViewMode },
    { label: 'Integrations', icon: <IconPlug className="h-5 w-5 shrink-0 text-neutral-400" />, view: 'connectors' as ViewMode },
    { label: 'Entities', icon: <IconUsers className="h-5 w-5 shrink-0 text-neutral-400" />, view: 'entities' as ViewMode },
    { label: 'Projects', icon: <IconFolders className="h-5 w-5 shrink-0 text-neutral-400" />, view: 'projects' as ViewMode },
    { label: 'Chat', icon: <IconMessageCircle className="h-5 w-5 shrink-0 text-neutral-400" />, view: 'memory-chat' as ViewMode },
    { label: 'Models', icon: <IconDownload className="h-5 w-5 shrink-0 text-neutral-400" />, view: 'models' as ViewMode },
    {
      label: 'Notifications',
      icon: (
        <div className="relative">
          <IconBell className="h-5 w-5 shrink-0 text-neutral-400" />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-red-500 text-[9px] font-medium text-white px-1">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </div>
      ),
      view: 'notifications' as ViewMode
    },
    { label: 'Settings', icon: <IconSettings className="h-5 w-5 shrink-0 text-neutral-400" />, view: 'settings' as ViewMode },
  ];

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
          <SidebarBody className="justify-between gap-10 bg-neutral-900/80 backdrop-blur-xl border-r border-neutral-800">
            <div className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden">
              {/* Logo + open/close toggle (the whole row toggles the sidebar) */}
              <button onClick={() => setSidebarOpen((o) => !o)} className="flex items-center gap-2 py-2 w-full" title={sidebarOpen ? 'Collapse' : 'Expand'}>
                <img src={logo} alt="Off Grid" className="h-8 w-8 shrink-0 rounded-lg" />
                <motion.span
                  animate={{
                    display: sidebarOpen ? 'inline-block' : 'none',
                    opacity: sidebarOpen ? 1 : 0,
                  }}
                  className="flex-1 text-left font-semibold text-white whitespace-pre"
                >
                  Off Grid AI Desktop
                </motion.span>
                {sidebarOpen && <IconChevronLeft className="h-4 w-4 shrink-0 text-neutral-500" />}
              </button>

              {/* Navigation */}
              <div className="mt-8 flex flex-col gap-2">
                {navItems.map((item) => (
                  <button
                    key={item.view}
                    onClick={() => {
                      posthog.capture('button_clicked', { button_name: 'navigation_' + item.view })
                      setViewMode(item.view); setSelectedSessionId(null); setSelectedMemoryId(null); setSelectedEntityId(null); setReplayTarget(null);
                    }}
                    className={cn(
                      "flex items-center gap-2 py-2 px-2 rounded-lg transition-colors group/sidebar",
                      viewMode === item.view
                        ? "bg-neutral-800 text-white"
                        : "text-neutral-400 hover:bg-neutral-800/50 hover:text-white"
                    )}
                  >
                    {item.icon}
                    <motion.span
                      animate={{
                        display: sidebarOpen ? 'inline-block' : 'none',
                        opacity: sidebarOpen ? 1 : 0,
                      }}
                      className="text-sm whitespace-pre group-hover/sidebar:translate-x-1 transition duration-150"
                    >
                      {item.label}
                    </motion.span>
                  </button>
                ))}
              </div>
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
                  {viewMode === 'day' ? (
                    <DayView />
                  ) : viewMode === 'replay' ? (
                    <ReplayScreen seekToMs={replayTarget ?? undefined} />
                  ) : viewMode === 'reflect' ? (
                    <ReflectScreen />
                  ) : viewMode === 'actions' ? (
                    <ActionsScreen />
                  ) : viewMode === 'connectors' ? (
                    <ConnectorsScreen />
                  ) : viewMode === 'meetings' ? (
                    <MeetingsScreen rec={rec} />
                  ) : viewMode === 'memory-chat' ? (
                    <MemoryChat
                      onNavigateToMemory={handleSelectMemory}
                      onNavigateToChat={handleSelectChat}
                      onNavigateToEntity={handleSelectEntity}
                      openTarget={chatTarget}
                      onTargetConsumed={() => setChatTarget(null)}
                    />
                  ) : viewMode === 'chats' ? (
                    <ChatList onSelectSession={setSelectedSessionId} />
                  ) : viewMode === 'memories' ? (
                    <MemoryList selectedMemoryId={selectedMemoryId} onClearSelection={() => setSelectedMemoryId(null)} />
                  ) : viewMode === 'entities' ? (
                    <EntitiesScreen />
                  ) : viewMode === 'search' ? (
                    <SearchScreen initialQuery={searchQuery} onOpen={handleOpenHit} />
                  ) : viewMode === 'notifications' ? (
                    <NotificationList
                      onSelectChat={handleSelectChat}
                      onSelectMemory={handleSelectMemory}
                      onSelectEntity={handleSelectEntity}
                    />
                  ) : viewMode === 'models' ? (
                    <ModelsScreen />
                  ) : viewMode === 'projects' ? (
                    <ProjectsScreen onOpenChat={handleOpenProjectChat} />
                  ) : viewMode === 'settings' ? (
                    <Settings />
                  ) : (
                    <EntityGraph />
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
