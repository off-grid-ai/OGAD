// MCP OAuth — the flow that makes hosted connectors (Notion, Linear, Jira,
// GitHub, …) actually authorize. Implements the SDK's OAuthClientProvider backed
// by the encrypted secret store (tokens/client-registration in Keychain), opens
// the system browser for consent, and catches the redirect on a localhost
// loopback. Uses PKCE + dynamic client registration (no per-provider client_id
// to pre-bake). Tokens auto-refresh via the SDK on later calls.

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { app, shell } from 'electron';
import { getSecret, setSecret, deleteSecret } from './secrets';

// The Off Grid brand mark, served by the loopback at /oglogo.png so the consent
// success page (and its favicon) show the real logo instead of a generic glyph.
let logoCache: Buffer | null = null;
function logoBytes(): Buffer | null {
  if (logoCache) return logoCache;
  for (const c of [
    path.join(process.resourcesPath ?? '', 'icon.png'),
    path.join(app.getAppPath?.() ?? '', 'resources', 'icon.png'),
    path.join(process.cwd(), 'resources', 'icon.png'),
  ]) {
    try {
      if (c && fs.existsSync(c)) {
        logoCache = fs.readFileSync(c);
        return logoCache;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

const REDIRECT_PORT = 33418;
const REDIRECT_URL = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

// A pre-registered OAuth client to use INSTEAD of dynamic client registration.
// Google has no DCR, so we ship a client_id/secret and pin the request to a
// least-privilege read scope + offline access (to get a refresh token).
export interface StaticOAuthClient {
  client_id: string;
  client_secret: string;
  scope: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeOAuthProvider(connectorId: number, google?: StaticOAuthClient, interactive = true): any {
  const skey = (k: string): string => `connector:${connectorId}:oauth:${k}`;
  const loadJson = <T>(k: string): T | undefined => {
    const v = getSecret(skey(k));
    return v ? (JSON.parse(v) as T) : undefined;
  };
  // Set when redirectToAuthorization runs (during connect, before it throws), so
  // the caller can await the code routed back to us by `state`.
  let pendingCode: Promise<string> | null = null;

  return {
    getCodePromise(): Promise<string> {
      if (!pendingCode) throw new Error('no pending authorization');
      return pendingCode;
    },
    get redirectUrl(): string {
      return REDIRECT_URL;
    },
    get clientMetadata() {
      return {
        client_name: 'Off Grid AI Desktop',
        redirect_uris: [REDIRECT_URL],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        // Google Desktop clients send the secret on token exchange; DCR uses none.
        token_endpoint_auth_method: google ? 'client_secret_post' : 'none',
        ...(google ? { scope: google.scope } : {}),
      };
    },
    state(): string {
      return crypto.randomBytes(16).toString('hex');
    },
    clientInformation() {
      // Static (Google) client → skip DCR; otherwise use the registered one.
      if (google) return { client_id: google.client_id, client_secret: google.client_secret };
      return loadJson('client');
    },
    saveClientInformation(info: unknown): void {
      if (google) return; // fixed client — nothing to persist
      setSecret(skey('client'), JSON.stringify(info));
    },
    tokens() {
      return loadJson('tokens');
    },
    saveTokens(t: unknown): void {
      setSecret(skey('tokens'), JSON.stringify(t));
    },
    saveCodeVerifier(v: string): void {
      setSecret(skey('verifier'), v);
    },
    codeVerifier(): string {
      const v = getSecret(skey('verifier'));
      if (!v) throw new Error('missing PKCE code verifier');
      return v;
    },
    redirectToAuthorization(url: URL): void {
      // Background (non-interactive) connects must NEVER pop a login — if the
      // saved token is stale, the sync just fails quietly and the user can
      // reconnect from the UI. Only interactive connects open the browser.
      if (!interactive) return;
      if (google) {
        // Google needs these for a refresh token, and we pin the scope so we
        // only ever request the least-privilege read scope (not every scope the
        // MCP server advertises, which would exceed the consent screen).
        url.searchParams.set('access_type', 'offline');
        url.searchParams.set('prompt', 'consent');
        url.searchParams.set('scope', google.scope);
      }
      // Register for the redirect (keyed by state) BEFORE opening the browser, so
      // even an instant skip-consent redirect is caught by the persistent server.
      pendingCode = awaitOAuthCode(url.searchParams.get('state') ?? '');
      shell.openExternal(url.toString());
    },
    invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
      if (scope === 'all' || scope === 'tokens') deleteSecret(skey('tokens'));
      if (scope === 'all' || scope === 'client') deleteSecret(skey('client'));
      if (scope === 'all' || scope === 'verifier') deleteSecret(skey('verifier'));
    },
  };
}

/** True if we already hold tokens for this connector (so connect is silent). */
export function hasOAuthTokens(connectorId: number): boolean {
  return !!getSecret(`connector:${connectorId}:oauth:tokens`);
}

export function clearOAuth(connectorId: number): void {
  const base = `connector:${connectorId}:oauth:`;
  deleteSecret(base + 'tokens');
  deleteSecret(base + 'client');
  deleteSecret(base + 'verifier');
}

const SUCCESS_HTML = (err: string | null): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Off Grid AI Desktop</title><link rel="icon" type="image/png" href="/oglogo.png"></head><body style="font-family:Menlo,ui-monospace,monospace;background:#0a0a0a;color:#e5e5e5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><img src="/oglogo.png" alt="Off Grid" width="80" height="80" style="border-radius:18px;margin:0 auto 20px;display:block"><h2 style="color:#34D399;font-weight:500">${err ? 'Authorization failed' : 'Connected to Off Grid'}</h2><p style="color:#737373">You can close this tab and return to the app.</p></div></body></html>`;

// ONE persistent loopback server for the whole app lifetime. Each authorization
// is keyed by its OAuth `state`, so concurrent/retried connects never collide on
// the port and a code is always routed to the right request. This replaces the
// fragile per-attempt servers (which caused ERR_CONNECTION_REFUSED races).
interface Pending { resolve: (c: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
const pendingByState = new Map<string, Pending>();
let loopback: http.Server | null = null;

export function ensureLoopback(): void {
  if (loopback) return;
  const server = http.createServer((req, res) => {
    try {
      const u = new URL(req.url ?? '', REDIRECT_URL);
      if (u.pathname === '/oglogo.png') {
        const b = logoBytes();
        if (b) {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(b);
        } else {
          res.writeHead(404);
          res.end();
        }
        return;
      }
      if (!u.pathname.startsWith('/callback')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const state = u.searchParams.get('state') ?? '';
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(SUCCESS_HTML(err));
      // Match by state; if the provider didn't echo one, fall back to the sole
      // pending request (the common single-connect case).
      const p =
        pendingByState.get(state) ??
        (pendingByState.size === 1 ? [...pendingByState.values()][0] : undefined);
      if (!p) return;
      pendingByState.delete(state);
      clearTimeout(p.timer);
      if (err) p.reject(new Error(`OAuth error: ${err}`));
      else if (code) p.resolve(code);
      else p.reject(new Error('No authorization code in redirect'));
    } catch {
      /* ignore malformed callback */
    }
  });
  server.on('error', (e) => {
    console.error('[oauth] loopback error', e);
    loopback = null;
  });
  server.listen(REDIRECT_PORT, '127.0.0.1', () => {
    loopback = server;
    console.log('[oauth] loopback listening on', REDIRECT_PORT);
  });
  loopback = server; // mark immediately so we don't double-bind
}

/** Register interest in the code for an OAuth `state` (server already listening). */
export function awaitOAuthCode(state: string, timeoutMs = 3 * 60 * 1000): Promise<string> {
  ensureLoopback();
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingByState.delete(state);
      reject(new Error('Authorization timed out'));
    }, timeoutMs);
    pendingByState.set(state, { resolve, reject, timer });
  });
}
