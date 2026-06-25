import { spawn, execSync, ChildProcess } from "child_process";
import { Mutex } from "async-mutex";
import { callHook } from "./bootstrap/hookRegistry";
import path from "path";
import { app } from "electron";
import * as fs from "fs";
import * as http from "http";

// Models live under the unified userData dir (pinned in main/index.ts), so this
// stays consistent with the DB + embeddings paths instead of a hardcoded name.
function getModelsDir(): string {
    return path.join(app.getPath('userData'), 'models');
}

export interface LlmSettings {
  temperature?: number;
  ctxSize?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export class LLMService {
  private server: ChildProcess | null = null;
  // Off the contested 8080 (collides with other local dev servers) onto a
  // less-trafficked port so the model server reliably binds.
  private port = 8439;
  // Single-flight init guard: concurrent chat() calls (e.g. the capture
  // extractor firing rapidly) must share ONE spawn, not each launch a server.
  private initPromise: Promise<void> | null = null;
  private modelPath = "";
  private mmProjPath = ""; // empty for text-only models (no vision projector)
  private initialized = false;
  // Paused during image generation: on Apple Silicon unified memory the LLM and
  // the image model can't both be resident. While paused we DON'T respawn the
  // server — capture keeps running but its LLM distillation is deferred until
  // generation finishes (and the LLM warms back up).
  private paused = false;
  private activeModelFile = path.join(getModelsDir(), "active-model.json");
  // User-tunable inference settings (persisted). Context window needs a server
  // respawn to take effect (it's a launch arg); temperature is per-request.
  private temperature = 0.7;
  private ctxSize = 65536; // 64k — gemma-4 trains to 131k, so this is safe headroom and stops "context exceeded"
  // ONE local gemma server, but many callers (capture distill, day-plan, the
  // secretary, action extraction…). Concurrent requests contend and time out.
  // Serialize them so each gets the server to itself; the per-call timeout sits
  // INSIDE the lock, so it measures execution, not time spent waiting in line.
  private chatMutex = new Mutex();
  // Advanced sampling (LM Studio-style). undefined = let llama.cpp use its default.
  private topP: number | undefined;
  private topK: number | undefined;
  private minP: number | undefined;
  private repeatPenalty: number | undefined;
  private maxTokens = 2048;
  private systemPrompt = '';
  private settingsFile = path.join(getModelsDir(), "llm-settings.json");

  constructor() {
    this.resolveModel();
    try {
      const s = JSON.parse(fs.readFileSync(this.settingsFile, "utf-8"));
      if (typeof s.temperature === "number") this.temperature = s.temperature;
      if (typeof s.ctxSize === "number") this.ctxSize = s.ctxSize;
      if (typeof s.topP === "number") this.topP = s.topP;
      if (typeof s.topK === "number") this.topK = s.topK;
      if (typeof s.minP === "number") this.minP = s.minP;
      if (typeof s.repeatPenalty === "number") this.repeatPenalty = s.repeatPenalty;
      if (typeof s.maxTokens === "number") this.maxTokens = s.maxTokens;
      if (typeof s.systemPrompt === "string") this.systemPrompt = s.systemPrompt;
    } catch { /* defaults */ }
  }

  getSettings(): LlmSettings {
    return {
      temperature: this.temperature, ctxSize: this.ctxSize,
      topP: this.topP, topK: this.topK, minP: this.minP,
      repeatPenalty: this.repeatPenalty, maxTokens: this.maxTokens,
      systemPrompt: this.systemPrompt,
    };
  }

  /** Sampling params to merge into a request payload (only those the user set). */
  private samplingPayload(): Record<string, number> {
    const p: Record<string, number> = {};
    if (typeof this.topP === "number") p.top_p = this.topP;
    if (typeof this.topK === "number") p.top_k = this.topK;
    if (typeof this.minP === "number") p.min_p = this.minP;
    if (typeof this.repeatPenalty === "number") p.repeat_penalty = this.repeatPenalty;
    return p;
  }

  /** Update inference settings; respawns the server if the context window changed. */
  async setSettings(s: LlmSettings): Promise<void> {
    const ctxChanged = typeof s.ctxSize === "number" && s.ctxSize !== this.ctxSize;
    if (typeof s.temperature === "number") this.temperature = s.temperature;
    if (typeof s.ctxSize === "number") this.ctxSize = s.ctxSize;
    if (typeof s.topP === "number") this.topP = s.topP;
    if (typeof s.topK === "number") this.topK = s.topK;
    if (typeof s.minP === "number") this.minP = s.minP;
    if (typeof s.repeatPenalty === "number") this.repeatPenalty = s.repeatPenalty;
    if (typeof s.maxTokens === "number") this.maxTokens = s.maxTokens;
    if (typeof s.systemPrompt === "string") this.systemPrompt = s.systemPrompt;
    try { fs.writeFileSync(this.settingsFile, JSON.stringify(this.getSettings())); } catch { /* ignore */ }
    if (ctxChanged && !this.paused) {
      this.stop();
      await this.init();
    }
  }

  // Resolve the active model's files. The Models screen writes active-model.json
  // ({ id, primary, mmproj }) after resolving a catalog entry; default to the
  // bundled Qwen3-VL vision model when nothing is selected yet.
  private resolveModel(): void {
    const modelsDir = getModelsDir();
    try {
      const cfg = JSON.parse(fs.readFileSync(this.activeModelFile, "utf-8"));
      if (cfg?.primary) {
        this.modelPath = path.join(modelsDir, cfg.primary);
        this.mmProjPath = cfg.mmproj ? path.join(modelsDir, cfg.mmproj) : "";
        return;
      }
    } catch {
      // no active selection yet
    }
    this.modelPath = path.join(modelsDir, "Qwen3-VL-4B-Instruct-Q4_K_M.gguf");
    this.mmProjPath = path.join(modelsDir, "mmproj-Qwen3VL-4B-Instruct-F16.gguf");
  }

  /** Switch the active model and force a reload on next init. */
  reloadModel(): void {
    if (this.server) {
      this.server.kill();
      this.server = null;
    }
    this.initialized = false;
    this.resolveModel();
  }

  // Check if the active model's files are present (mmproj only if it has one).
  modelsExist(): boolean {
    this.resolveModel();
    return fs.existsSync(this.modelPath) && (!this.mmProjPath || fs.existsSync(this.mmProjPath));
  }

  getModelsDir(): string {
    return getModelsDir();
  }

  async init(): Promise<void> {
    if (this.paused) return; // don't respawn while paused for image generation
    if (this.initialized) return;
    // Coalesce concurrent inits into one spawn.
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInit().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async _doInit() {
    if (this.initialized) return;

    this.resolveModel();

    // Check if models exist
    if (!this.modelsExist()) {
      console.error(`[LLMService] Models not found. Please download them first.`);
      console.error(`[LLMService] Expected model: ${this.modelPath}`);
      console.error(`[LLMService] Expected mmproj: ${this.mmProjPath}`);
      throw new Error("Models not downloaded. Please complete onboarding to download the AI model.");
    }

    // Prefer the updated, self-contained llama.cpp build in bin/llama (supports
    // newer architectures like gemma4); fall back to the legacy bin/llama-server.
    const roots = app.isPackaged
        ? [path.join(process.resourcesPath, "bin")]
        : [path.join(app.getAppPath(), "resources", "bin"), path.join(process.cwd(), "resources", "bin")];
    const candidates = roots.flatMap((r) => [
        path.join(r, "llama", "llama-server"),
        path.join(r, "llama-server"),
    ]);
    const serverPath = candidates.find((p) => fs.existsSync(p)) ?? "";
    if (!serverPath) {
        console.error(`[LLMService] llama-server binary not found. Looked in:\n${candidates.join("\n")}`);
        return;
    }

    console.log(`[LLMService] Starting llama-server from ${serverPath}`);
    console.log(`[LLMService] Model: ${this.modelPath}`);

    // Strip macOS quarantine attributes on production builds (downloaded DMGs get quarantined)
    if (app.isPackaged && process.platform === 'darwin') {
        try {
            const binDir = path.dirname(serverPath);
            execSync(`xattr -cr "${binDir}"`, { stdio: 'ignore' });
            execSync(`chmod +x "${serverPath}"`, { stdio: 'ignore' });
            console.log('[LLMService] Cleared quarantine attributes from bin directory');
        } catch (e) {
            console.warn('[LLMService] Could not clear quarantine attributes:', e);
        }
    }

    const binDir = path.dirname(serverPath);

    const args = ["-m", this.modelPath];
    if (this.mmProjPath) args.push("--mmproj", this.mmProjPath);
    args.push(
      "--port", String(this.port),
      "--host", "127.0.0.1",
      "-c", String(this.ctxSize),
      "-ngl", "99"
    );
    // Kill any lingering server before spawning (defends against a crashed or
    // orphaned instance still holding the port / RAM).
    if (this.server) {
      try { this.server.kill("SIGKILL"); } catch { /* ignore */ }
      this.server = null;
    }
    // ALSO kill an ORPHANED server from a previous app process — when the app
    // restarts, the old llama-server keeps holding the port, so a new spawn can't
    // bind and config changes (ctx size, model) silently never take effect. Find
    // whatever owns the port and kill it.
    try {
      const pids = execSync(`lsof -ti tcp:${this.port}`, { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
      let killed = 0;
      for (const pid of pids) {
        // ONLY kill a process we recognize as our own llama-server. The port is
        // ours by convention, not by reservation — blindly SIGKILLing whatever
        // holds it would take down an unrelated app that happened to bind it.
        let cmd = "";
        try { cmd = execSync(`ps -p ${pid} -o command=`, { encoding: "utf-8" }).trim(); } catch { continue; /* already gone */ }
        if (!/llama-server/i.test(cmd)) {
          console.warn(`[LLMService] port ${this.port} held by non-llama process ${pid} (${cmd.slice(0, 80)}) — leaving it alone`);
          continue;
        }
        try { process.kill(Number(pid), "SIGKILL"); killed++; console.log(`[LLMService] killed orphaned llama-server ${pid} on port ${this.port}`); } catch { /* gone */ }
      }
      if (killed) await new Promise((r) => setTimeout(r, 400)); // let the port free
    } catch { /* nothing on the port */ }

    this.server = spawn(serverPath, args, {
      env: {
        ...process.env,
        DYLD_LIBRARY_PATH: binDir,
      },
    });

    this.server.stderr?.on("data", (data) => {
      console.log(`[llama-server] ${data}`);
    });

    this.server.on("close", (code) => {
        console.log(`[llama-server] exited with code ${code}`);
        this.server = null;
        this.initialized = false;
    });

    try {
        await this.waitForReady();
        console.log("[LLMService] Vision server ready!");
        this.initialized = true;
    } catch (e) {
        console.error("[LLMService] Failed to start server:", e);
        this.stop();
    }
  }

  private async waitForReady(timeout = 60000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`);
        if (res.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("Server failed to start");
  }

  // Use Node http module instead of fetch to avoid undici's headersTimeout (300s)
  // which kills long-running LLM requests before they can respond
  private httpPost(body: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        req.destroy();
        reject(new Error("LLM request timed out - try a shorter prompt"));
      }, timeoutMs);

      const req = http.request({
        hostname: '127.0.0.1',
        port: this.port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          clearTimeout(timer);
          if (timedOut) return;
          if (res.statusCode !== 200) {
            reject(new Error(`LLM Server Error: ${res.statusCode} ${data}`));
            return;
          }
          resolve(data);
        });
      });

      req.on('error', (e) => {
        clearTimeout(timer);
        if (timedOut) return;
        reject(e);
      });

      req.write(body);
      req.end();
    });
  }

  async chat(
    message: string,
    images: string[] = [],
    timeoutMs: number = 300000,
    maxTokens: number = 2048,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts: { responseFormat?: any; temperature?: number; disableThinking?: boolean } = {}
  ): Promise<string> {
    if (this.paused) throw new Error("LLM paused during image generation — deferred");
    if (!this.initialized) {
        await this.init();
        if (!this.initialized) {
             throw new Error("LLM Service not ready");
        }
    }

    return this.chatMutex.runExclusive(async () => {
    try {
        const messages: any[] = [{
            role: "user",
            content: []
        }];

        messages[0].content.push({ type: "text", text: message });

        for (const imgPath of images) {
            try {
                const imageBuffer = fs.readFileSync(imgPath);
                const base64 = imageBuffer.toString("base64");
                const mime = imgPath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

                messages[0].content.push({
                    type: "image_url",
                    image_url: {
                        url: `data:${mime};base64,${base64}`
                    }
                });
            } catch (readErr) {
                console.error(`[LLMService] Failed to read image ${imgPath}:`, readErr);
            }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (this.systemPrompt.trim()) messages.unshift({ role: "system", content: this.systemPrompt });
        const payload: any = {
            messages: messages,
            max_tokens: maxTokens,
            temperature: opts.temperature ?? this.temperature,
            ...this.samplingPayload(),
        };
        // Grammar-constrained output: llama.cpp converts the JSON schema to a
        // GBNF grammar so the model can ONLY emit valid matching JSON.
        if (opts.responseFormat) payload.response_format = opts.responseFormat;
        // Turn off the model's reasoning channel for fast, direct output (its
        // chain-of-thought otherwise eats the token budget and leaves content empty).
        if (opts.disableThinking) payload.chat_template_kwargs = { enable_thinking: false };
        const body = JSON.stringify(payload);

        console.log(`[LLMService] Starting LLM request (timeout: ${timeoutMs/1000}s, body: ${body.length} chars)...`);

        const raw = await this.httpPost(body, timeoutMs);
        const data = JSON.parse(raw);
        console.log('[LLMService] LLM request completed');
        // Best-effort fleet audit: record the local model call if enrolled in a
        // console. The fleet console is a pro feature — it registers this hook in
        // its activation; the free build has no hook and this is a no-op.
        try {
            const tokens = data.usage?.total_tokens ?? 0;
            const modelName = path.basename(this.modelPath) || 'local-llm';
            callHook('console.recordModelCall', modelName, tokens, 'ok', false);
        } catch { /* audit is never load-bearing */ }
        return data.choices?.[0]?.message?.content ?? "";

    } catch (e: any) {
        console.error("[LLMService] Chat error:", e.message || e);
        throw e;
    }
    });
  }

  // Streaming variant of chat(): posts with stream:true and invokes `onDelta`
  // for each token as it arrives. Separates the model's reasoning channel
  // (delta.reasoning_content, or text inside <think>…</think>) from the answer
  // (delta.content). Returns the full answer text when the stream ends.
  async chatStream(
    message: string,
    images: string[] = [],
    onDelta: (text: string, kind: 'content' | 'reasoning') => void,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts: { temperature?: number; thinking?: boolean; signal?: AbortSignal } = {},
    maxTokens: number = 2048,
    timeoutMs: number = 300000,
  ): Promise<string> {
    if (this.paused) throw new Error('LLM paused during image generation — deferred');
    if (!this.initialized) {
      await this.init();
      if (!this.initialized) throw new Error('LLM Service not ready');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content: any[] = [{ type: 'text', text: message }];
    for (const imgPath of images) {
      try {
        const base64 = fs.readFileSync(imgPath).toString('base64');
        const mime = imgPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } });
      } catch (e) {
        console.error(`[LLMService] Failed to read image ${imgPath}:`, e);
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages: any[] = [{ role: 'user', content }];
    if (this.systemPrompt.trim()) messages.unshift({ role: 'system', content: this.systemPrompt });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: any = {
      messages,
      max_tokens: this.maxTokens || maxTokens,
      temperature: opts.temperature ?? this.temperature,
      ...this.samplingPayload(),
      stream: true,
    };
    // Thinking control: when on, ask the template to emit reasoning and have
    // llama.cpp split it into reasoning_content (deepseek-style); when off,
    // suppress it so the token budget goes to the answer.
    if (opts.thinking) {
      payload.chat_template_kwargs = { enable_thinking: true };
      payload.reasoning_format = 'deepseek';
    } else {
      payload.chat_template_kwargs = { enable_thinking: false };
    }
    const body = JSON.stringify(payload);

    return new Promise<string>((resolve, reject) => {
      let full = '';
      let buf = '';
      let inThink = false; // for models that inline <think>…</think> in content
      let timedOut = false;
      let aborted = false;
      const timer = setTimeout(() => { timedOut = true; req.destroy(); reject(new Error('LLM request timed out')); }, timeoutMs);

      const emitContent = (text: string): void => {
        // Split out inline <think> reasoning if the template uses it.
        let rest = text;
        while (rest) {
          if (inThink) {
            const end = rest.indexOf('</think>');
            if (end === -1) { onDelta(rest, 'reasoning'); return; }
            if (end > 0) onDelta(rest.slice(0, end), 'reasoning');
            rest = rest.slice(end + 8);
            inThink = false;
          } else {
            const start = rest.indexOf('<think>');
            if (start === -1) { full += rest; onDelta(rest, 'content'); return; }
            if (start > 0) { full += rest.slice(0, start); onDelta(rest.slice(0, start), 'content'); }
            rest = rest.slice(start + 7);
            inThink = true;
          }
        }
      };

      const req = http.request({
        hostname: '127.0.0.1',
        port: this.port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        if (res.statusCode !== 200) { clearTimeout(timer); reject(new Error(`LLM Server Error: ${res.statusCode}`)); res.resume(); return; }
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buf += chunk;
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const delta = JSON.parse(data).choices?.[0]?.delta;
              if (delta?.reasoning_content) onDelta(delta.reasoning_content, 'reasoning');
              if (delta?.content) emitContent(delta.content);
            } catch { /* partial/ignorable line */ }
          }
        });
        res.on('end', () => { clearTimeout(timer); if (!timedOut && !aborted) resolve(full); });
      });
      req.on('error', (e) => { clearTimeout(timer); if (!timedOut && !aborted) reject(e); });
      // Cooperative cancellation: stop the request and return whatever was generated so far.
      if (opts.signal) {
        const onAbort = (): void => { aborted = true; clearTimeout(timer); try { req.destroy(); } catch { /* already gone */ } resolve(full); };
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      req.write(body);
      req.end();
    });
  }

  stop() {
    if (this.server) {
        this.server.kill();
        this.server = null;
        this.initialized = false;
    }
  }

  /** Pause for image generation: free the server and block respawns until resumed. */
  pause() {
    this.paused = true;
    this.stop();
  }

  /** Resume after image generation and warm the server back up. */
  resume() {
    this.paused = false;
    this.init().catch(() => {});
  }

  isReady() {
      return this.initialized;
  }
}

export const llm = new LLMService();

app.on("before-quit", () => {
    llm.stop();
});
