# Retention backup: archive-before-delete + automatic history cleanup

Status: Phase 1 in progress (branch `feat/retention-backup`). Phase 2 not started.

## Problem

Continuous screen capture writes full-resolution PNGs into `captures/` with no retention:
~170MB/day (~5GB/month) measured on a live profile (1,379 files / 838MB over ~5 days). Nothing
prunes automatically - the only lever is the manual "delete older than N days" button in
Settings > Data & Privacy, and that delete is permanent. There is no way to keep old history
before clearing it: the existing backup engine (`src/main/backup/`) exports projects +
conversations only, never the capture/meeting files that retention deletes.

## Phase 1 - "Back up & delete" (manual, this branch)

A fail-closed archive step in front of the existing category delete.

User-visible behavior:

1. Settings > Data & Privacy grows a "Back up & delete" action next to the existing delete and
   retention buttons for the file-centric categories (captures, meetings, generated images).
2. Clicking it opens the normal save dialog. The user picks any destination (external SSD, NAS).
3. The app stages one ZIP - e.g. `offgrid-captures-before-2026-07-26.zip` - containing every file
   the delete would remove, plus a `manifest.json` (category, cutoff, created-at, file count,
   total bytes).
4. Only after the ZIP is confirmed delivered does the real delete run. Cancel or any archive
   failure = nothing is deleted, ever.

Design:

- **One source of truth for "what a category deletes".** The per-category userData dir list moves
  out of `clearCategory`'s switch into a pure module (`src/main/data-categories.ts`) that both the
  delete path and the archive path read. Two lists would drift into "backed up X, deleted Y".
- **Collector** - `collectCategoryFiles(dirs, olderThanDays?)` returns exactly the files
  `clearDirs`/`clearDirsOlderThan` would remove (same mtime cutoff).
- **Stager** - streams the files into a ZIP via JSZip with STORE compression (PNGs do not
  compress; the corpus is ~1GB, so never buffer it in memory) + writes `manifest.json`.
- **Orchestrator** - `archiveThenClear(category, olderThanDays)`: collect -> stage -> deliver via
  the existing `DesktopBackupSink` (save dialog) -> on confirmed delivery only, call the existing
  `clearCategory`. Zero files to archive skips the dialog and clears directly. The destination is
  injectable (sink today, fixed folder later) so Phase 2 reuses the same seam.
- **Untouched contracts** - `clearCategory` itself does not change; pro's
  `clearRemovedCaptureProjections` keys off missing files and we copy before deleting, so the pro
  side needs zero changes.
- **Tests in the same pass** - the dir-map DRY guard, age-cutoff selection, ZIP + manifest
  contents, and the ordering contract (canceled/failed archive leaves every file in place), run
  against real temp dirs with a fake sink.

## Phase 2 - automatic history cleanup (next)

One setting plus a nightly job, built on the Phase 1 seam:

- Settings: "Keep screen history for 30 / 60 / 90 days / forever" + optional archive folder.
- A scheduled daily job runs the same archive-then-delete machinery with a fixed-folder
  destination instead of a dialog: old frames archived (if a folder is set), then pruned. Disk
  usage stays flat at roughly one retention window.
- Ships OFF by default; deleting history silently is an explicit opt-in.
- This matches the field standard: Microsoft Recall caps storage and deletes oldest-first;
  Rewind asks once how long to keep history.

Out of scope for both phases (tracked separately in the bloat notes): compressing captures at
write time (WebP/JPEG instead of PNG) and encoding frames into HEVC segments for Replay.
