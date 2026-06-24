// Secure secret storage — OAuth tokens, connector credentials, API keys. Backed
// by Electron safeStorage (macOS Keychain under the hood), so secrets are
// encrypted at rest with an OS-held key, NEVER plaintext in SQLite. This is a
// hard prerequisite for the "act" pillar: an integration that leaks tokens
// violates the off-grid promise.

import { safeStorage } from 'electron';
import { getDB } from './database';

let ready = false;
function ensure(): void {
  if (ready) return;
  getDB().exec(
    `CREATE TABLE IF NOT EXISTS secrets (
       key TEXT PRIMARY KEY,
       blob BLOB NOT NULL,            -- safeStorage-encrypted bytes
       updated_at INTEGER NOT NULL DEFAULT 0
     )`
  );
  ready = true;
}

/** True if the OS provides real encryption (Keychain available). */
export function secretsAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function setSecret(key: string, value: string): boolean {
  ensure();
  if (!secretsAvailable()) {
    console.error('[secrets] OS encryption unavailable — refusing to store plaintext');
    return false;
  }
  const enc = safeStorage.encryptString(value);
  getDB()
    .prepare(
      `INSERT INTO secrets (key, blob, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`
    )
    .run(key, enc, Date.now());
  return true;
}

export function getSecret(key: string): string | null {
  ensure();
  const row = getDB().prepare('SELECT blob FROM secrets WHERE key = ?').get(key) as { blob: Buffer } | undefined;
  if (!row) return null;
  try {
    return safeStorage.decryptString(row.blob);
  } catch (e) {
    console.error('[secrets] decrypt failed for', key, e);
    return null;
  }
}

export function deleteSecret(key: string): void {
  ensure();
  getDB().prepare('DELETE FROM secrets WHERE key = ?').run(key);
}

/** Key names only (never values) — for showing what's stored without exposing it. */
export function listSecretKeys(): string[] {
  ensure();
  return (getDB().prepare('SELECT key FROM secrets ORDER BY key').all() as { key: string }[]).map((r) => r.key);
}
