import { desktopCapturer, app, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

export class VisionService {
    private capturesDir: string;

    constructor() {
        this.capturesDir = path.join(app.getPath('userData'), 'captures');
        if (!fs.existsSync(this.capturesDir)) {
            fs.mkdirSync(this.capturesDir, { recursive: true });
        }
    }

    async captureAppWindow(
        appName: string,
        windowTitle?: string,
        bounds?: { x: number; y: number; width: number; height: number }
    ): Promise<string | null> {
        try {
            console.log(`Vision: Attempting to capture window for ${appName} (Title: ${windowTitle || 'Any'})...`);

            // 1) Best case: an EXACT window-title match for the focused window. Only
            // trust an exact match — fuzzy/app-name matching against window titles is
            // unreliable and used to fall through to grabbing the wrong window (the
            // old "any window containing 'claude'" hack captured the Claude desktop
            // app no matter what app was actually focused).
            if (windowTitle && windowTitle.trim()) {
                const windows = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1920, height: 1080 } });
                const exact = windows.find(s => s.name === windowTitle);
                if (exact && !exact.thumbnail.isEmpty()) {
                    return await this.writeThumb(exact.thumbnail.toPNG());
                }
            }

            // 2) Robust fallback: capture the ACTIVE SCREEN (the display under the
            // cursor / where the focused app lives). This is the ground truth of what
            // the user is actually looking at — no window guessing, and it's the
            // direction we want anyway (record what's on screen).
            const screens = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
            if (!screens.length) {
                console.log('Vision: No screen sources available');
                return null;
            }
            let target = screens[0];
            try {
                // Pick the display the FOCUSED WINDOW is on (its center), NOT the
                // cursor — on multi-monitor the cursor is often on a different screen
                // than the focused app, which captured the wrong monitor (e.g. the
                // Claude window) while you were actually in the terminal/browser.
                const point =
                    bounds && Number.isFinite(bounds.x)
                        ? { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }
                        : screen.getCursorScreenPoint();
                const display = screen.getDisplayNearestPoint(point);
                const match = screens.find(s => s.display_id === String(display.id));
                if (match) target = match;
            } catch {
                /* single display — first screen is fine */
            }
            if (target.thumbnail.isEmpty()) {
                console.log('Vision: Active screen thumbnail empty (screen may be locked)');
                return null;
            }
            return await this.writeThumb(target.thumbnail.toPNG());
        } catch (e) {
            console.error("Vision Capture Failed:", e);
            return null;
        }
    }

    private async writeThumb(png: Buffer): Promise<string> {
        const filePath = path.join(this.capturesDir, `capture-${Date.now()}.png`);
        await fs.promises.writeFile(filePath, png);
        console.log(`Vision: Captured ${filePath}`);
        return filePath;
    }

    cleanup(filePath: string) {
        fs.unlink(filePath, (err) => {
             if (err) console.error("Failed to cleanup capture:", err);
        });
    }
}

/**
 * The focused window's rectangle expressed as a FRACTION of its display — used to
 * crop a full-display screenshot down to exactly that window. Window bounds are
 * global (screen) coords; we subtract the window's display origin and divide by
 * the display size. desktopCapturer thumbnails preserve the display's aspect
 * ratio, so these fractions map cleanly onto the screenshot pixels. Returns null
 * if bounds are missing/degenerate (caller then OCRs the whole screen).
 */
export function windowRegionOnDisplay(
    bounds?: { x: number; y: number; width: number; height: number }
): { x: number; y: number; w: number; h: number } | null {
    if (!bounds || !Number.isFinite(bounds.x) || bounds.width < 50 || bounds.height < 50) return null;
    try {
        const center = { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
        const db = screen.getDisplayNearestPoint(center).bounds;
        if (!db.width || !db.height) return null;
        const clamp = (n: number): number => Math.min(1, Math.max(0, n));
        const r = {
            x: clamp((bounds.x - db.x) / db.width),
            y: clamp((bounds.y - db.y) / db.height),
            w: clamp(bounds.width / db.width),
            h: clamp(bounds.height / db.height),
        };
        // Ignore if it's basically the whole display (no useful crop) or degenerate.
        if (r.w < 0.15 || r.h < 0.15) return null;
        if (r.x <= 0.01 && r.y <= 0.01 && r.w >= 0.99 && r.h >= 0.99) return null;
        return r;
    } catch {
        return null;
    }
}

export const vision = new VisionService();
