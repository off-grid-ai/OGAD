import { useState, useEffect, useCallback } from 'react';
import { motion, stagger, useAnimate } from 'motion/react';
import { StarsBackground } from './ui/stars-background';
import { ShootingStars } from './ui/shooting-stars';
import { BorderBeam } from './ui/border-beam';
import { cn } from '@renderer/lib/utils';
import { Shield, Eye, Check, X, Gear as Settings, ArrowsClockwise as RefreshCw, Download, Cpu } from '@phosphor-icons/react';
import { ModelsScreen } from './ModelsScreen';

interface PermissionGateProps {
  children: React.ReactNode;
}

// Text Generate Effect for the title
function TextGenerate({ words, className, delay = 0 }: { words: string; className?: string; delay?: number }) {
  const [scope, animate] = useAnimate();
  const wordsArray = words.split(" ");

  useEffect(() => {
    const timer = setTimeout(() => {
      animate(
        "span",
        { opacity: 1, filter: "blur(0px)" },
        { duration: 0.4, delay: stagger(0.08) }
      );
    }, delay * 1000);

    return () => clearTimeout(timer);
  }, [animate, delay]);

  return (
    <motion.div ref={scope} className={cn("inline", className)}>
      {wordsArray.map((word, idx) => (
        <motion.span
          key={word + idx}
          className="opacity-0 inline-block"
          style={{ filter: "blur(8px)" }}
        >
          {word}{idx < wordsArray.length - 1 ? "\u00A0" : ""}
        </motion.span>
      ))}
    </motion.div>
  );
}

export function PermissionGate({ children }: PermissionGateProps) {
  const [permissionStatus, setPermissionStatus] = useState<PermissionStatus | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [modelStatus, setModelStatus] = useState<{ downloaded: boolean; modelsDir: string } | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ modelName: string; percent: number; downloadedMB: string; totalMB: string } | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [showModels, setShowModels] = useState(false);

  const checkPermissions = useCallback(async () => {
    try {
      const status = await window.api.getPermissionStatus();
      console.log('Permission status:', status);
      setPermissionStatus(status);
      setIsChecking(false);
      return status.allGranted;
    } catch (e) {
      console.error('Failed to check permissions:', e);
      setIsChecking(false);
      return false;
    }
  }, []);

  const checkModelStatus = useCallback(async () => {
    try {
      const status = await window.api.checkModelStatus();
      console.log('Model status:', status);
      setModelStatus(status);
      return status.downloaded;
    } catch (e) {
      console.error('Failed to check model status:', e);
      return false;
    }
  }, []);

  // Initial check
  useEffect(() => {
    checkPermissions();
    checkModelStatus();
  }, [checkPermissions, checkModelStatus]);

  // Poll for permission changes when permissions are not granted
  useEffect(() => {
    if (permissionStatus?.allGranted && modelStatus?.downloaded) return;

    const interval = setInterval(() => {
      checkPermissions();
      checkModelStatus();
    }, 2000);

    return () => clearInterval(interval);
  }, [permissionStatus?.allGranted, modelStatus?.downloaded, checkPermissions, checkModelStatus]);

  // Subscribe to download progress
  useEffect(() => {
    const unsubscribe = window.api.onModelDownloadProgress((data) => {
      setDownloadProgress(data);
    });
    return unsubscribe;
  }, []);

  const handleOpenAccessibilitySettings = async () => {
    try {
      await window.api.openAccessibilitySettings();
    } catch (e) {
      console.error('Failed to open accessibility settings:', e);
    }
  };

  const handleOpenScreenRecordingSettings = async () => {
    try {
      await window.api.openScreenRecordingSettings();
    } catch (e) {
      console.error('Failed to open screen recording settings:', e);
    }
  };

  const handleDownloadModel = async () => {
    setIsDownloading(true);
    setDownloadError(null);
    setDownloadProgress(null);

    try {
      const result = await window.api.downloadModels();
      if (result.success) {
        await checkModelStatus();
      } else {
        setDownloadError(result.error || 'Download failed');
      }
    } catch (e: any) {
      console.error('Failed to download model:', e);
      setDownloadError(e.message || 'Download failed');
    } finally {
      setIsDownloading(false);
      setDownloadProgress(null);
    }
  };

  const handleRefresh = () => {
    setIsChecking(true);
    checkPermissions();
    checkModelStatus();
  };

  // Loading state
  if (isChecking && !permissionStatus) {
    return (
      <div className="h-screen w-screen bg-neutral-950 flex items-center justify-center fixed inset-0">
        <StarsBackground className="absolute inset-0 z-0" />
        <motion.div
          initial={{ opacity: 0, filter: 'blur(10px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="relative z-10 text-center"
        >
          <div className="w-8 h-8 mx-auto mb-4 border-2 border-neutral-700 border-t-neutral-400 rounded-full animate-spin" />
          <p className="text-neutral-500 text-sm">Checking permissions</p>
        </motion.div>
      </div>
    );
  }

  // Everything granted - render children
  if (permissionStatus?.allGranted && modelStatus?.downloaded) {
    return (
      children
    );
  }

  // Browse the full model catalog (text, vision, image, voice, transcription).
  // Downloading + Using a text/vision model flips modelStatus and opens the app.
  if (showModels) {
    return (
      <div className="fixed inset-0 z-50 h-screen w-screen overflow-hidden bg-neutral-950">
        <button
          onClick={() => setShowModels(false)}
          className="absolute left-4 top-4 z-20 flex items-center gap-1 text-sm text-neutral-400 transition-colors hover:text-white"
        >
          ← Back to setup
        </button>
        <div className="h-full w-full pt-12">
          <ModelsScreen />
        </div>
      </div>
    );
  }

  // Setup required - show permission/model request UI
  return (
    <div className="h-screen w-screen bg-neutral-950 fixed inset-0 overflow-hidden">
      <StarsBackground className="absolute inset-0 z-0" />
      <ShootingStars className="absolute inset-0 z-0" />

      <div className="relative z-10 h-full w-full flex flex-col items-center overflow-y-auto pt-16 pb-8 px-8">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="w-full max-w-3xl"
        >
          {/* Icon */}
          <motion.div
            initial={{ opacity: 0, scale: 0.8, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="flex justify-center mb-8"
          >
            <div className="w-16 h-16 rounded-2xl bg-neutral-900/80 border border-neutral-800 flex items-center justify-center backdrop-blur-xl">
              <Shield className="w-7 h-7 text-neutral-500" />
            </div>
          </motion.div>

          {/* Title with text generate effect */}
          <div className="text-center mb-3">
            <TextGenerate
              words="Setup Required"
              className="text-4xl font-light text-white tracking-tight"
              delay={0.2}
            />
          </div>

          {/* Subtitle */}
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5, duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="text-center text-neutral-500 text-sm mb-10 max-w-xs mx-auto leading-relaxed"
          >
            Grant permissions and download the AI model to get started. Everything runs locally on your device.
          </motion.p>

          {/* Permission & Model Cards - 3 columns on desktop */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-8">
            <PermissionCard
              title="Accessibility"
              description="Read text from AI chat windows"
              icon={<Eye className="w-5 h-5" />}
              granted={permissionStatus?.accessibility ?? false}
              onOpenSettings={handleOpenAccessibilitySettings}
              delay={0.6}
            />

            <PermissionCard
              title="Screen Recording"
              description="Capture visual context for OCR"
              icon={<Shield className="w-5 h-5" />}
              granted={permissionStatus?.screenRecording ?? false}
              onOpenSettings={handleOpenScreenRecordingSettings}
              delay={0.7}
            />

            {/* AI Model - opens the catalog (text, vision, image, voice, transcription) */}
            <motion.button
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.8, duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
              onClick={() => setShowModels(true)}
              className="flex h-full flex-col gap-3 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 text-left transition-colors hover:border-green-500/60"
            >
              <div className="flex items-center justify-between">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-neutral-800 bg-neutral-800/60">
                  <Cpu className="h-5 w-5 text-neutral-500" />
                </div>
                <span className="whitespace-nowrap text-xs text-green-500">
                  {modelStatus?.downloaded ? 'Done' : 'Browse →'}
                </span>
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium text-white">AI Model</div>
                <div className="text-xs text-neutral-500">
                  {modelStatus?.downloaded ? 'Model ready' : 'Choose & download a model'}
                </div>
              </div>
            </motion.button>
          </div>

          {/* Instructions */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.9, duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="bg-neutral-900/40 border border-neutral-800/60 rounded-xl p-4 mb-6"
          >
            <div className="flex items-center gap-2 mb-3">
              <Settings className="w-3.5 h-3.5 text-neutral-600" />
              <span className="text-[10px] font-medium text-neutral-600 uppercase tracking-widest">
                How to enable
              </span>
            </div>
            <div className="space-y-2 text-sm text-neutral-500">
              <p>1. Click <span className="text-neutral-400">Open Settings</span> for each permission</p>
              <p>2. Find <span className="text-neutral-400">Off Grid AI Desktop</span> in the list</p>
              <p>3. Toggle the switch to enable</p>
              <p>4. Click <span className="text-neutral-400">Download Model</span> to get the AI</p>
            </div>
          </motion.div>

          {/* Refresh Button */}
          <motion.button
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1, duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
            onClick={handleRefresh}
            disabled={isChecking}
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.99 }}
            className={cn(
              "w-full py-3 rounded-xl font-medium transition-all",
              "bg-neutral-900/80 border border-neutral-800 text-neutral-300",
              "hover:bg-neutral-800 hover:border-neutral-700 hover:text-white",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "flex items-center justify-center gap-2"
            )}
          >
            <RefreshCw className={cn("w-4 h-4", isChecking && "animate-spin")} />
            {isChecking ? 'Checking' : 'Check Again'}
          </motion.button>

          {/* Status indicator */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.1 }}
            className="flex items-center justify-center gap-2 mt-4"
          >
            <div className="w-1.5 h-1.5 rounded-full bg-neutral-700 animate-pulse" />
            <span className="text-[10px] text-neutral-600 uppercase tracking-widest">
              Auto-checking
            </span>
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}

interface PermissionCardProps {
  title: string;
  description: string;
  icon: React.ReactNode;
  granted: boolean;
  onOpenSettings: () => void;
  delay?: number;
}

function PermissionCard({ title, description, icon, granted, onOpenSettings, delay = 0 }: PermissionCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
      whileHover={{ scale: 1.01 }}
      className={cn(
        "relative rounded-xl border p-4 transition-all duration-300 overflow-hidden",
        granted
          ? "bg-neutral-900/60 border-neutral-700"
          : "bg-neutral-900/40 border-neutral-800 hover:border-neutral-700 hover:bg-neutral-900/60"
      )}
    >
      {granted && (
        <BorderBeam
          size={200}
          duration={10}
          borderWidth={1.5}
        />
      )}

      {/* Vertical column card (desktop grid) */}
      <div className="flex h-full flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className={cn(
            "w-12 h-12 rounded-xl flex items-center justify-center border transition-all duration-300",
            granted
              ? "bg-neutral-800 border-neutral-700 text-neutral-300"
              : "bg-neutral-800/60 border-neutral-800 text-neutral-500"
          )}>
            {icon}
          </div>
          {granted && (
            <span className="text-[10px] text-neutral-500 uppercase tracking-widest">Enabled</span>
          )}
        </div>

        <div className="flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <h3 className="font-medium text-white text-sm">{title}</h3>
            <div className={cn(
              "w-4 h-4 rounded-full flex items-center justify-center transition-all duration-300",
              granted ? "bg-neutral-700" : "bg-neutral-800/60"
            )}>
              {granted ? <Check className="w-2.5 h-2.5 text-neutral-300" /> : <X className="w-2.5 h-2.5 text-neutral-600" />}
            </div>
          </div>
          <p className="text-xs text-neutral-500">{description}</p>
        </div>

        {!granted && (
          <button
            onClick={onOpenSettings}
            className={cn(
              "w-full px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-200",
              "bg-neutral-800 border border-neutral-700 text-neutral-300",
              "hover:bg-neutral-700 hover:text-white"
            )}
          >
            Open Settings
          </button>
        )}
      </div>
    </motion.div>
  );
}

interface ModelCardProps {
  downloaded: boolean;
  isDownloading: boolean;
  downloadProgress: { modelName: string; percent: number; downloadedMB: string; totalMB: string } | null;
  downloadError: string | null;
  onDownload: () => void;
  delay?: number;
}

function ModelCard({ downloaded, isDownloading, downloadProgress, downloadError, onDownload, delay = 0 }: ModelCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
      whileHover={{ scale: 1.01 }}
      className={cn(
        "relative rounded-xl border p-4 transition-all duration-300 overflow-hidden",
        downloaded
          ? "bg-neutral-900/60 border-neutral-700"
          : "bg-neutral-900/40 border-neutral-800 hover:border-neutral-700 hover:bg-neutral-900/60"
      )}
    >
      {downloaded && (
        <BorderBeam
          size={200}
          duration={10}
          borderWidth={1.5}
        />
      )}

      <div className="flex items-center gap-4">
        {/* Icon */}
        <div className={cn(
          "w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 border transition-all duration-300",
          downloaded
            ? "bg-neutral-800 border-neutral-700 text-neutral-300"
            : "bg-neutral-800/60 border-neutral-800 text-neutral-500"
        )}>
          <Cpu className="w-5 h-5" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <h3 className="font-medium text-white text-sm">AI Model</h3>
            <div className={cn(
              "w-4 h-4 rounded-full flex items-center justify-center transition-all duration-300",
              downloaded ? "bg-neutral-700" : "bg-neutral-800/60"
            )}>
              {downloaded ? (
                <Check className="w-2.5 h-2.5 text-neutral-300" />
              ) : (
                <X className="w-2.5 h-2.5 text-neutral-600" />
              )}
            </div>
          </div>

          {isDownloading && downloadProgress ? (
            <div className="space-y-1">
              <p className="text-xs text-neutral-400">
                {downloadProgress.modelName.split('-')[0]}... {downloadProgress.percent}%
              </p>
              <div className="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-neutral-500 rounded-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${downloadProgress.percent}%` }}
                  transition={{ duration: 0.3 }}
                />
              </div>
              <p className="text-[10px] text-neutral-600">
                {downloadProgress.downloadedMB} / {downloadProgress.totalMB} MB
              </p>
            </div>
          ) : downloadError ? (
            <p className="text-xs text-red-400">{downloadError}</p>
          ) : (
            <p className="text-xs text-neutral-500">Qwen3-VL-4B (local processing)</p>
          )}
        </div>

        {/* Status/Actions */}
        <div className="flex-shrink-0">
          {downloaded ? (
            <span className="text-[10px] text-neutral-500 uppercase tracking-widest">
              Ready
            </span>
          ) : (
            <button
              onClick={onDownload}
              disabled={isDownloading}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 flex items-center gap-1.5",
                "bg-neutral-800 border border-neutral-700 text-neutral-300",
                "hover:bg-neutral-700 hover:text-white",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              <Download className={cn("w-3 h-3", isDownloading && "animate-pulse")} />
              {isDownloading ? 'Downloading...' : 'Download'}
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}
