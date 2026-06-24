// Fleet Console node client. Opt-in: when the user enrolls this device into an Off Grid Console,
// we (1) pull the org policy bundle, (2) push audit events for local model calls, and (3) poll
// for commands (kill switch). Everything is best-effort and non-blocking — the app works fully
// whether or not it's enrolled, and a console outage never degrades local capture/inference.
import * as os from "os";
import { getSetting, saveSetting } from "./database";

interface NodePolicy {
  version: number;
  egressAllowed: boolean;
  guardrails: string[];
  allowedModels: string[];
  updatedAt: string;
}

interface AuditEvt {
  ts: string;
  model: string;
  tokens: number;
  leftDevice: boolean;
  tool: string | null;
  outcome: "ok" | "blocked" | "redacted";
}

export interface ConsoleStatus {
  enrolled: boolean;
  url: string;
  deviceId: string;
  lastSync: number;
  policyVersion: number | null;
  killed: boolean;
  queued: number;
}

const K = {
  url: "console:url",
  token: "console:token",
  device: "console:deviceId",
  policy: "console:policy",
  sync: "console:lastSync",
} as const;

const POLL_MS = 60_000;
const QUEUE_CAP = 1000;

let queue: AuditEvt[] = [];
let timer: NodeJS.Timeout | null = null;
let killed = false;

function base(): string {
  return getSetting<string>(K.url, "").replace(/\/+$/, "");
}

function deviceId(): string {
  return getSetting<string>(K.device, "");
}

export function isEnrolled(): boolean {
  return Boolean(deviceId() && base());
}

export function getActivePolicy(): NodePolicy | null {
  return getSetting<NodePolicy | null>(K.policy, null);
}

export function isKilled(): boolean {
  return killed;
}

// Best-effort: queue an audit event for the next flush. No-op when not enrolled.
export function recordModelCall(
  model: string,
  tokens: number,
  outcome: "ok" | "blocked" | "redacted" = "ok",
  leftDevice = false,
): void {
  if (!isEnrolled()) return;
  queue.push({ ts: new Date().toISOString(), model, tokens, leftDevice, tool: null, outcome });
  if (queue.length > QUEUE_CAP) queue = queue.slice(-QUEUE_CAP);
}

async function flushAudit(): Promise<void> {
  if (queue.length === 0 || !isEnrolled()) return;
  const events = queue.splice(0, queue.length);
  try {
    const res = await fetch(`${base()}/api/v1/devices/${deviceId()}/audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`audit ${res.status}`);
  } catch {
    // Re-queue (bounded) so a transient outage doesn't drop events.
    queue = [...events, ...queue].slice(-QUEUE_CAP);
  }
}

async function pollCommands(): Promise<void> {
  if (!isEnrolled()) return;
  try {
    const res = await fetch(`${base()}/api/v1/devices/${deviceId()}/commands`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { data?: { type: string }[] };
    for (const cmd of data.data ?? []) {
      if (cmd.type === "kill") killed = true;
    }
  } catch {
    // ignore — try again next tick
  }
}

export async function syncPolicyNow(): Promise<ConsoleStatus> {
  if (isEnrolled()) {
    try {
      const res = await fetch(`${base()}/api/v1/devices/${deviceId()}/policy`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        saveSetting(K.policy, (await res.json()) as NodePolicy);
        saveSetting(K.sync, Date.now());
      }
    } catch {
      // offline — keep last-known policy
    }
    await flushAudit();
    await pollCommands();
  }
  return getConsoleStatus();
}

export function getConsoleStatus(): ConsoleStatus {
  return {
    enrolled: isEnrolled(),
    url: base(),
    deviceId: deviceId(),
    lastSync: getSetting<number>(K.sync, 0),
    policyVersion: getActivePolicy()?.version ?? null,
    killed,
    queued: queue.length,
  };
}

export async function enrollDevice(
  url: string,
  token: string,
): Promise<{ enrolled: boolean; deviceId?: string; error?: string }> {
  const root = url.replace(/\/+$/, "");
  try {
    const res = await fetch(`${root}/api/v1/devices/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, name: os.hostname(), os: "macOS" }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const code = res.status === 401 ? "invalid or used token" : `enroll failed (${res.status})`;
      return { enrolled: false, error: code };
    }
    const data = (await res.json()) as { device?: { id: string } };
    const id = data.device?.id;
    if (!id) return { enrolled: false, error: "no device id returned" };
    saveSetting(K.url, root);
    saveSetting(K.token, token);
    saveSetting(K.device, id);
    killed = false;
    startConsoleNode();
    await syncPolicyNow();
    return { enrolled: true, deviceId: id };
  } catch (e) {
    return { enrolled: false, error: e instanceof Error ? e.message : "network error" };
  }
}

export function disconnectConsole(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  for (const key of Object.values(K)) saveSetting(key, null);
  queue = [];
  killed = false;
}

// Start the background loop (idempotent). Called on app start and right after enrollment.
export function startConsoleNode(): void {
  if (!isEnrolled() || timer) return;
  timer = setInterval(() => {
    void syncPolicyNow();
  }, POLL_MS);
  void syncPolicyNow();
}
