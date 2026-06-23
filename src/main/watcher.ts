import { spawn, ChildProcess } from 'child_process';
import { app, BrowserWindow } from 'electron';
import path from 'path';
import { vision } from './vision';
// import { llm } from "./llm";
import { getDB } from './database'; // Need DB to save memories directly? Or send to renderer? 
// Better to send to renderer or use IPC handling flow? 
// Actually, watcher usually broadcasts. We can do side-effect logic here.
import { parseClaudeDesktopOutput, parseClaudeWebOutput, parseChatGPTOutput, parseGeminiOutput } from './parsers';

export class Watcher {
  private static child: ChildProcess | null = null;
  private static intentionalStop = false;
  // Legacy My Memories AI-chat scraping (Claude/ChatGPT/Gemini → conversations).
  // Off Grid captures via screen/OCR instead, so this is permanently off.
  private static readonly COLLECT_AI_CHATS = false;

  static start() {
    if (this.child) return;
    this.intentionalStop = false;

    const isDev = !app.isPackaged;
    // In dev, usually compiled to electron/accessibility/watcher
    // In prod, it should be in Resources
    const binPath = isDev 
      ? path.join(process.cwd(), 'electron/accessibility/watcher')
      : path.join(process.resourcesPath, 'watcher'); 

    console.log("[Watcher] Spawning Watcher from:", binPath);

    // Check availability
    const fs = require('fs');
    if (!fs.existsSync(binPath)) {
        console.error(`[Watcher] CRITICAL: Binary not found at ${binPath}`);
        // Log contents of resources path to help debug
        if (!isDev) {
            try {
                const resources = fs.readdirSync(process.resourcesPath);
                console.log("[Watcher] Contents of resourcesPath:", resources);
            } catch(e) {
                console.error("[Watcher] Could not list resourcesPath:", e);
            }
        }
        return;
    }

    // Strip macOS quarantine attributes on production builds (downloaded DMGs get quarantined)
    if (!isDev && process.platform === 'darwin') {
        try {
            const { execSync } = require('child_process');
            execSync(`xattr -cr "${binPath}"`, { stdio: 'ignore' });
            execSync(`chmod +x "${binPath}"`, { stdio: 'ignore' });
            console.log('[Watcher] Cleared quarantine attributes from watcher binary');
        } catch (e) {
            console.warn('[Watcher] Could not clear quarantine attributes:', e);
        }
    }

    this.child = spawn(binPath, []);

    // Auto-restart watcher if it crashes (but not on intentional stop)
    this.child.on('close', (code) => {
        console.warn(`[Watcher] Process exited with code ${code}`);
        this.child = null;
        if (!this.intentionalStop) {
            setTimeout(() => {
                console.log('[Watcher] Restarting...');
                this.start();
            }, 5000);
        }
    });

    this.child.stderr?.on('data', (data) => {
      console.error("Watcher Error:", data.toString());
      if (data.toString().includes("errm")) { // Permission denied check
           BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('watcher:permission-denied');
        });
      }
    });

    this.child.stdout?.on('data', (data) => {
      try {
        const str = data.toString().trim();
        if (!str) return;

        // Handle potentially multiple JSON objects in one chunk
        const lines = str.split('\n');
        for (const line of lines) {
             try {
                const json = JSON.parse(line);
                console.log("Watcher JSON received:", JSON.stringify(json).slice(0, 200)); // Debug log

                // Broadcast to all windows
                BrowserWindow.getAllWindows().forEach(win => {
                    win.webContents.send('watcher:data', json);
                });

                // VISION TRIGGER
                if (json.appName) {
                    this.handleVisionCapture(json.appName, json.title).catch(err => {
                        console.error('[Watcher] Vision capture failed:', err);
                    });
                }

                // GENERIC CAPTURE: distill an observation from ANY app's on-screen
                // text (the Swift layer already extracts text for every focused
                // app). The extractor self-gates on length / dedupe / per-app
                // interval / noise, so this is safe to fire on every signal.
                // Generic CRM capture now runs via the get-windows focus loop in
                // main/focus.ts (reliable where this spawned watcher couldn't see
                // some apps, e.g. iTerm2). The watcher is kept for chat-app parsing.

             } catch (e) {
                 // Ignore partial lines or non-JSON
             }
        }
      } catch (e) {
        // console.error("Watcher Parse Error:", e);
      }
    });
  }

  // Simple debounce tracking
  private static lastCaptureTime: number = 0;
  private static CAPTURE_INTERVAL = 30000; // 30s
  private static lastTitle: string = "";

  private static extractBrowserUrl(text: string): string | undefined {
      const lines = text.split('\n');
      for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("[BROWSER_URL]")) {
              return trimmed.replace("[BROWSER_URL]", "").trim() || undefined;
          }
      }
      return undefined;
  }

  private static isBrowserApp(appName: string): boolean {
      const name = (appName || '').toLowerCase();
      return [
          'chrome',
          'google chrome',
          'brave',
          'arc',
          'safari',
          'firefox',
          'edge',
          'microsoft edge',
          'opera'
      ].some(token => name.includes(token));
  }

  private static isClaudeDomain(url: string): boolean {
      const raw = (url || '').trim();
      if (!raw) return false;

      const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
      try {
          const hostname = new URL(withScheme).hostname.toLowerCase();
          return hostname === 'claude.ai' || hostname.endsWith('.claude.ai');
      } catch {
          const lower = raw.toLowerCase();
          return /(^|\/|\.|:)claude\.ai(\/|$)/i.test(lower);
      }
  }

  private static isChatGPTDomain(url: string): boolean {
      const raw = (url || '').trim();
      if (!raw) return false;

      const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
      try {
          const hostname = new URL(withScheme).hostname.toLowerCase();
          return hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com') || hostname === 'chat.openai.com' || hostname.endsWith('.chat.openai.com');
      } catch {
          const lower = raw.toLowerCase();
          return /(^|\/|\.|:)chatgpt\.com(\/|$)/i.test(lower) || /(^|\/|\.|:)chat\.openai\.com(\/|$)/i.test(lower);
      }
  }

  private static isGeminiDomain(url: string): boolean {
      const raw = (url || '').trim();
      if (!raw) return false;

      const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
      try {
          const hostname = new URL(withScheme).hostname.toLowerCase();
          return hostname === 'gemini.google.com' || hostname.endsWith('.gemini.google.com') || hostname === 'bard.google.com' || hostname.endsWith('.bard.google.com');
      } catch {
          const lower = raw.toLowerCase();
          return /(^|\/|\.|:)gemini\.google\.com(\/|$)/i.test(lower) || /(^|\/|\.|:)bard\.google\.com(\/|$)/i.test(lower);
      }
  }

  // Check if a URL is an actual chat page (not pricing, settings, or empty starters)
  private static isClaudeChatUrl(url: string): boolean {
      const raw = (url || '').trim();
      if (!raw) return false;
      const withScheme = /^[a-z]+:\/\//.test(raw) ? raw : `https://${raw}`;
      try {
          const parsed = new URL(withScheme);
          const pathname = parsed.pathname.toLowerCase();
          // Only claude.ai/chat/* pages have actual content
          // Exclude: /, /new, /pricing, /settings, /login, /signup, /api, /docs, etc.
          return pathname.startsWith('/chat/');
      } catch {
          return false;
      }
  }

  private static isChatGPTChatUrl(url: string): boolean {
      const raw = (url || '').trim();
      if (!raw) return false;
      const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
      try {
          const parsed = new URL(withScheme);
          const pathname = parsed.pathname.toLowerCase();
          // Only chatgpt.com/c/* (actual chats) or chatgpt.com/g/* (GPTs with context)
          // Exclude: /, /auth, /share, /pricing, etc.
          return pathname.startsWith('/c/') || pathname.startsWith('/g/');
      } catch {
          return false;
      }
  }

  private static isGeminiChatUrl(url: string): boolean {
      const raw = (url || '').trim();
      if (!raw) return false;
      const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
      try {
          const parsed = new URL(withScheme);
          const pathname = parsed.pathname.toLowerCase();
          // gemini.google.com/app/* or gemini.google.com/u/N/app/* (multi-account) or home
          return /\/(app)(\/|$)/.test(pathname) || pathname === '/' || pathname === '';
      } catch {
          return false;
      }
  }

  // Sanitize browser names from titles and add -browser suffix for browser-sourced chats
  private static sanitizeBrowserTitle(title: string | undefined, isBrowser: boolean): string {
      if (!title) return isBrowser ? 'Untitled Chat-browser' : 'Untitled Chat';
      
      // Skip "New tab" type pages - these aren't real chats
      const lowerTitle = title.toLowerCase();
      if (lowerTitle.includes('new tab') || lowerTitle === 'new page' || lowerTitle.startsWith('about:')) {
          return '';  // Empty signals to skip this capture
      }
      
      const browserPatterns = [
          // Pattern: "Title - Brave" or "Title - Chrome - Work"
          /\s*[-–—|]\s*(Brave|Chrome|Safari|Firefox|Edge|Arc|Opera)(\s*[-–—|]\s*\w+)?(\s+Browser)?(\s+Window)?$/i,
          // Pattern: "Brave - Title" at start
          /^(Brave|Chrome|Safari|Firefox|Edge|Arc|Opera)(\s+Browser)?(\s+Window)?\s*[-–—|]\s*/i,
          // Pattern: "title brave work browser" - browser name anywhere with optional profile
          /\s+(brave|chrome|safari|firefox|edge|arc|opera)(\s+\w+)?\s*(browser|window)?\s*$/i,
          // Google Chrome / Microsoft Edge
          /\s*[-–—|]\s*Google Chrome(\s*[-–—|]\s*\w+)?$/i,
          /\s*[-–—|]\s*Microsoft Edge(\s*[-–—|]\s*\w+)?$/i,
      ];
      
      let sanitized = title;
      for (const pattern of browserPatterns) {
          sanitized = sanitized.replace(pattern, '').trim();
      }
      
      // If after sanitization the title is empty, just "Claude", or just whitespace
      const sanitizedLower = sanitized.toLowerCase();
      if (!sanitized || sanitized.length < 2 || sanitizedLower === 'claude' || sanitizedLower === 'new chat') {
          return isBrowser ? 'Untitled Chat-browser' : 'Untitled Chat';
      }
      
      // Add -browser suffix for browser-sourced chats
      if (isBrowser) {
          return `${sanitized}-browser`;
      }
      
      return sanitized;
  }

  private static async handleVisionCapture(appName: string, title?: string) {
      // Legacy "My Memories" behaviour: scrape Claude/ChatGPT/Gemini chats into
      // the conversations table. Off Grid captures via screen/OCR instead, so this
      // collection is disabled. (Existing scraped data is purged on startup.)
      if (!Watcher.COLLECT_AI_CHATS) return;
      const isClaudeDesktop = appName.toLowerCase().includes("claude");
      const isBrowser = this.isBrowserApp(appName);
      // Only support Claude desktop or supported browser-based chat domains
      if (!isClaudeDesktop && !isBrowser) return;

      const now = Date.now();
      
      // Debounce
      const titleChanged = title && title !== this.lastTitle;
      if (!titleChanged && (now - this.lastCaptureTime < this.CAPTURE_INTERVAL)) return;

      this.lastCaptureTime = now;
      if (title) this.lastTitle = title;
      
      console.log(`Watcher: Triggering Vision Capture for ${appName} (Title: ${title})`);
      
      // 1. Extract Text First (Code-based Strategy)
      const { scraper } = await import("./scraper");
      let extractedText = "";
      try {
          extractedText = await scraper.getText(appName);
      } catch(e) { console.warn("Text extraction failed", e); }

      // Route by app/domain so each flow is isolated
      if (isClaudeDesktop) {
          await this.handleClaudeDesktopCapture(appName, title, extractedText);
          return;
      }

    const browserUrl = this.extractBrowserUrl(extractedText);
      const isClaudeBrowser = isBrowser && !!browserUrl && this.isClaudeDomain(browserUrl);
      const isChatGPTBrowser = isBrowser && !!browserUrl && this.isChatGPTDomain(browserUrl);
    const isGeminiBrowser = isBrowser && !!browserUrl && this.isGeminiDomain(browserUrl);

      // Check if URL is actually a chat page (not /pricing, /settings, etc.)
      if (isBrowser && isClaudeBrowser) {
          if (!this.isClaudeChatUrl(browserUrl)) {
              console.log(`Watcher: Skipping non-chat Claude URL: ${browserUrl}`);
              return;
          }
          await this.handleClaudeWebCapture(appName, title, extractedText);
          return;
      }

      if (isBrowser && isChatGPTBrowser) {
          if (!this.isChatGPTChatUrl(browserUrl)) {
              console.log(`Watcher: Skipping non-chat ChatGPT URL: ${browserUrl}`);
              return;
          }
          await this.handleChatGPTCapture(appName, title, extractedText);
          return;
      }

      if (isBrowser && isGeminiBrowser) {
          if (!this.isGeminiChatUrl(browserUrl)) {
              console.log(`Watcher: Skipping non-chat Gemini URL: ${browserUrl}`);
              return;
          }
          await this.handleGeminiCapture(appName, title, extractedText);
          return;
      }

      if (isBrowser && !isClaudeBrowser && !isChatGPTBrowser && !isGeminiBrowser) {
          return;
      }

      // 2. Fallback to Vision LLM if direct parsing failed (e.g. no accessibility classes found)
      console.log("Watcher: Direct parse failed (no semantic tags). Falling back to Vision LLM.");
      
      const imagePath = await vision.captureAppWindow(appName, title);
      
      if (imagePath) {
          try {
              // LLM Fallback Temporarily Disabled to prioritize Direct Parsing reliability
              // const { llm } = await import('./llm');
              // const prompt = `...`;
              
              // For now, simple log
              console.log("Watcher: Vision captured, but LLM extraction path is paused in favor of direct accessibility extraction.");
              
          } catch(e) {
              console.error("Vision Fallback Failed", e);
          }
      }
  }

  private static async handleClaudeDesktopCapture(appName: string, title: string | undefined, extractedText: string) {
      const parsedResult = parseClaudeDesktopOutput(extractedText);
      const parsedMessages = parsedResult.messages;
      const chatTitle = parsedResult.chatTitle;

      if (parsedMessages.length > 0) {
          const effectiveTitle = chatTitle || title || "Untitled Chat";
          console.log(`Watcher: Claude Desktop parse success. Found ${parsedMessages.length} messages. Chat: ${effectiveTitle}`);
          await this.saveConversationToDB(appName, effectiveTitle, parsedMessages);
      }
  }

  private static async handleClaudeWebCapture(_appName: string, title: string | undefined, extractedText: string) {
      const parsedResult = parseClaudeWebOutput(extractedText);
      const parsedMessages = parsedResult.messages;
      const chatTitle = parsedResult.chatTitle;

      if (parsedMessages.length > 0) {
          const rawTitle = chatTitle || title;
          const effectiveTitle = this.sanitizeBrowserTitle(rawTitle, true);
          // Skip if sanitization returned empty (New tab pages, etc.)
          if (!effectiveTitle) {
              console.log(`Watcher: Skipping Claude Web capture - New tab or empty page`);
              return;
          }
          console.log(`Watcher: Claude Web parse success. Found ${parsedMessages.length} messages. Chat: ${effectiveTitle}`);
          await this.saveConversationToDB("Claude.ai", effectiveTitle, parsedMessages);
      }
  }

  private static async handleChatGPTCapture(_appName: string, title: string | undefined, extractedText: string) {
      const parsedResult = parseChatGPTOutput(extractedText);
      const parsedMessages = parsedResult.messages;
      const chatTitle = parsedResult.chatTitle;

      if (parsedMessages.length > 0) {
          const rawTitle = chatTitle || title;
          const effectiveTitle = this.sanitizeBrowserTitle(rawTitle, true);
          // Skip if sanitization returned empty (New tab pages, etc.)
          if (!effectiveTitle) {
              console.log(`Watcher: Skipping ChatGPT capture - New tab or empty page`);
              return;
          }
          console.log(`Watcher: ChatGPT parse success. Found ${parsedMessages.length} messages. Chat: ${effectiveTitle}`);
          await this.saveConversationToDB("ChatGPT", effectiveTitle, parsedMessages);
      }
  }

  private static async handleGeminiCapture(_appName: string, title: string | undefined, extractedText: string) {
      const parsedResult = parseGeminiOutput(extractedText);
      const parsedMessages = parsedResult.messages;
      const chatTitle = parsedResult.chatTitle;

      if (parsedMessages.length > 0) {
          const derivedTitle = this.deriveGeminiTitleFromMessages(parsedMessages);
          const rawTitle = this.sanitizeGeminiTitle(chatTitle)
              || this.sanitizeGeminiTitle(derivedTitle)
              || this.sanitizeGeminiTitle(parsedResult.windowTitle)
              || this.sanitizeGeminiTitle(title);
          const effectiveTitle = this.sanitizeBrowserTitle(rawTitle, true);
          // Skip if sanitization returned empty (New tab pages, etc.)
          if (!effectiveTitle) {
              console.log(`Watcher: Skipping Gemini capture - New tab or empty page`);
              return;
          }
          console.log(`Watcher: Gemini parse success. Found ${parsedMessages.length} messages. Chat: ${effectiveTitle}`);
          await this.saveConversationToDB("Gemini", effectiveTitle, parsedMessages);
      }
  }

  private static deriveGeminiTitleFromMessages(messages: { role: string, content: string }[]): string | undefined {
      const assistant = messages.find(m => m.role.toLowerCase() === 'assistant' && m.content);
      if (!assistant) return undefined;
      const firstLine = assistant.content.split(/\n+/)[0]?.trim();
      if (!firstLine) return undefined;
      const cleaned = firstLine.replace(/\s+/g, ' ').slice(0, 80).trim();
      return cleaned || undefined;
  }

  private static sanitizeGeminiTitle(value: string | undefined): string | undefined {
      if (!value) return undefined;
      let cleaned = value.replace(/\s*[\-|•|\|]\s*gemini.*$/i, '').trim();
      cleaned = cleaned.replace(/^gemini\s*[-:]\s*/i, '').trim();
      if (!cleaned) return undefined;
      if (this.isLikelyGeminiPrompt(cleaned)) return undefined;
      return cleaned;
  }

  private static isLikelyGeminiPrompt(value: string): boolean {
      const lower = value.toLowerCase();
      if (lower.includes('?')) return true;
      if (lower.endsWith('.')) return true;
      if (lower.length > 120) return true;
      if (lower.split(/\s+/).length > 12) return true;
      const promptPhrases = [
          'would you like to',
          'how can i assist',
          'how can i help',
          'what can i help',
          'can i help you',
          'start a new draft'
      ];
      return promptPhrases.some(phrase => lower.includes(phrase));
  }

  // Refactored Helper - Divergence Point Deduplication
  private static async saveConversationToDB(appName: string, chatTitle: string, messages: { role: string, content: string, timestamp?: string }[]) {
        const db = getDB();

        // Use the passed chatTitle as-is (from [CHAT_TITLE] extraction)
        // "Untitled" is a valid title and will be displayed as-is
        const displayTitle = chatTitle || "Untitled";
        console.log(`Watcher: Using chat title: "${displayTitle}"`);

        // Session ID uses the display title for grouping
        const safeTitle = displayTitle.replace(/[^a-zA-Z0-9\-_]/g, '-').toLowerCase().slice(0, 60);
        const safeAppName = appName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        const sessionId = `${safeAppName}-${safeTitle}`;

        const upsertConv = db.prepare(`
            INSERT INTO conversations (id, title, app_name, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
        `);
        upsertConv.run(sessionId, displayTitle, appName);

        // Get existing messages for this conversation (oldest first for comparison)
        const existingMessages = db.prepare(`
            SELECT role, content, timestamp FROM messages 
            WHERE conversation_id = ? 
            ORDER BY created_at ASC
        `).all(sessionId) as { role: string, content: string, timestamp?: string }[];

        // Create signature for comparison (role + content + optional timestamp)
        const createSignature = (m: { role: string, content: string, timestamp?: string }) => {
            // Include timestamp if available for more precise matching
            const ts = m.timestamp || '';
            return `${m.role.toLowerCase()}|${ts}|${m.content}`;
        };

        // Find divergence point: where do the new messages start differing from existing?
        // Strategy: Find the last existing message in the new messages list
        let insertStartIndex = 0;
        
        if (existingMessages.length > 0) {
            // Get the last stored message's signature
            const lastExisting = existingMessages[existingMessages.length - 1];
            const lastExistingSig = createSignature(lastExisting);
            
            // Search backwards through new messages to find where we left off
            for (let i = messages.length - 1; i >= 0; i--) {
                const newSig = createSignature(messages[i]);
                if (newSig === lastExistingSig) {
                    // Found the match! Start inserting from the next message
                    insertStartIndex = i + 1;
                    break;
                }
            }
            
            // If no match found, check if all messages already exist (full overlap)
            if (insertStartIndex === 0) {
                const existingSet = new Set(existingMessages.map(createSignature));
                // Find first message that doesn't exist
                for (let i = 0; i < messages.length; i++) {
                    if (!existingSet.has(createSignature(messages[i]))) {
                        insertStartIndex = i;
                        break;
                    }
                }
                // If all match, nothing to insert
                if (insertStartIndex === 0 && existingSet.has(createSignature(messages[0]))) {
                    console.log(`Watcher: No new messages to insert for ${sessionId}`);
                    return;
                }
            }
        }

        // Insert only new messages starting from divergence point
        let inserted = 0;
        const insertedMessages: { id: number; role: string; content: string; timestamp?: string | null }[] = [];
        const insertStmt = db.prepare('INSERT INTO messages (conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?)');

        for (let i = insertStartIndex; i < messages.length; i++) {
            const msg = messages[i];
            const role = msg.role.toLowerCase();
            const text = msg.content;
            const timestamp = msg.timestamp || null;
            if (!text) continue;

            const info = insertStmt.run(sessionId, role, text, timestamp);
            const messageId = Number(info.lastInsertRowid || 0);
            console.log(`Watcher: Saved (${role}) [${timestamp || 'no-time'}]: ${text.substring(0, 30)}...`);
            inserted++;

            if (messageId) {
                insertedMessages.push({ id: messageId, role, content: text, timestamp });
            }
        }
        
        if (inserted > 0) {
            console.log(`Watcher: Inserted ${inserted} new messages for ${sessionId}`);

            // Send notification to renderer about new messages
            BrowserWindow.getAllWindows().forEach(win => {
                win.webContents.send('notification:new-messages', {
                    sessionId,
                    appName,
                    chatTitle: displayTitle,
                    count: inserted
                });
            });

            // Evaluate messages for memory storage
            if (insertedMessages.length > 0) {
                try {
                    const { evaluateAndStoreMemoryForMessage } = await import('./ipc');
                    await Promise.all(
                        insertedMessages.map((m) =>
                            evaluateAndStoreMemoryForMessage({
                                sessionId,
                                appName,
                                role: m.role,
                                content: m.content,
                                messageId: m.id
                            })
                        )
                    );
                } catch (e) {
                    console.error('Watcher: Memory evaluation failed', e);
                }
            }
            
            // Trigger automatic summarization
            try {
                // Dynamically import to avoid circular dependency issues if any, though static import is preferred if clean.
                // But watcher seems to use dynamic imports for other things. Let's try static first or keep consistent.
                // The watcher class is used in main process so it should be fine.
                // However, ipc.ts imports database, database imports... wait.
                // ipc.ts imports database. watcher imports database.
                // Let's use dynamic import for safety within the method.
                const { summarizeSession } = await import('./ipc');
                summarizeSession(sessionId).then(() => {
                    // Send notification when summary is generated
                    BrowserWindow.getAllWindows().forEach(win => {
                        win.webContents.send('notification:summary-generated', {
                            sessionId,
                            chatTitle: displayTitle
                        });
                    });
                }).catch(err => console.error("Watcher: Auto-summary failed", err));
            } catch (e) {
                console.error("Watcher: Failed to import/run summarization", e);
            }
        }
  }

  static stop() {
    this.intentionalStop = true;
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}
