// Approval queue + audit log — the spine of the "act" pillar. Anything Off Grid
// wants to DO on the user's behalf (send a draft, create a task via a connector)
// becomes a PROPOSAL here. The user approves or rejects; only on approval does it
// execute; every decision and execution is written to an immutable audit log.
// Nothing acts without a logged approval. This is where Actions ⇄ Integrations meet.

import { BrowserWindow } from 'electron';
import { getDB } from '../database';

let ready = false;
function ensure(): void {
  if (ready) return;
  getDB().exec(
    `CREATE TABLE IF NOT EXISTS approvals (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       title TEXT NOT NULL,              -- human summary: "Send draft reply to Ali"
       detail TEXT,                      -- what exactly will happen, in words
       connector TEXT,                   -- which MCP connector will run it
       tool TEXT,                        -- the tool name on that connector
       args TEXT,                        -- JSON args to the tool (shown for review)
       entity_name TEXT,                 -- project/person it relates to
       source TEXT,                      -- where the proposal came from (skill/action id)
       status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | executed | failed
       result TEXT,                      -- execution result / error
       created_at INTEGER NOT NULL DEFAULT 0,
       decided_at INTEGER
     );
     CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

     CREATE TABLE IF NOT EXISTS audit_log (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       ts INTEGER NOT NULL,
       action TEXT NOT NULL,             -- proposed | approved | rejected | executed | failed
       approval_id INTEGER,
       detail TEXT
     );
     CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);`
  );
  ready = true;
}

function emitChanged(): void {
  try {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('crm:changed'));
  } catch {
    /* ignore */
  }
}

function audit(action: string, approvalId: number | null, detail: string): void {
  getDB().prepare('INSERT INTO audit_log (ts, action, approval_id, detail) VALUES (?, ?, ?, ?)').run(Date.now(), action, approvalId, detail);
}

export interface Approval {
  id: number;
  title: string;
  detail: string | null;
  connector: string | null;
  tool: string | null;
  args: string | null;
  entity_name: string | null;
  source: string | null;
  status: string;
  result: string | null;
  created_at: number;
  decided_at: number | null;
}

export interface ProposeInput {
  title: string;
  detail?: string;
  connector?: string;
  tool?: string;
  args?: unknown;
  entityName?: string;
  source?: string;
}

/** Queue a proposed action for the user to approve. Returns the new approval id. */
export function proposeApproval(p: ProposeInput): number {
  ensure();
  const info = getDB()
    .prepare(
      `INSERT INTO approvals (title, detail, connector, tool, args, entity_name, source, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
    .run(
      p.title,
      p.detail ?? null,
      p.connector ?? null,
      p.tool ?? null,
      p.args !== undefined ? JSON.stringify(p.args) : null,
      p.entityName ?? null,
      p.source ?? null,
      Date.now()
    );
  const id = Number(info.lastInsertRowid);
  audit('proposed', id, p.title);
  emitChanged();
  try {
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send('notification:new-approval', {
        approvalId: id,
        title: p.title,
        detail: p.detail ?? '',
        entityName: p.entityName ?? null,
      })
    );
  } catch {
    /* ignore */
  }
  return id;
}

export function getApproval(id: number): Approval | undefined {
  ensure();
  return getDB().prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Approval | undefined;
}

export interface ApprovalProvenance {
  entityName: string | null;
  /** The recent on-device observations the proposal was grounded in. */
  basedOn: { surface: string; ts: string; summary: string }[];
}

/**
 * Where a proposal came from: the recent observations (calls / emails / notes)
 * about its linked entity — the evidence the secretary saw when it proposed this.
 */
export function getApprovalProvenance(id: number): ApprovalProvenance {
  ensure();
  const a = getApproval(id);
  if (!a) return { entityName: null, basedOn: [] };
  let basedOn: ApprovalProvenance['basedOn'] = [];
  if (a.entity_name) {
    basedOn = getDB()
      .prepare(
        `SELECT DISTINCT o.summary AS summary, o.surface AS surface, o.ts AS ts
         FROM observations o
         JOIN observation_entities oe ON oe.observation_id = o.id
         JOIN entities e ON e.id = oe.entity_id
         WHERE e.name = ? COLLATE NOCASE AND o.summary IS NOT NULL
         ORDER BY o.ts DESC LIMIT 6`
      )
      .all(a.entity_name) as ApprovalProvenance['basedOn'];
  }
  return { entityName: a.entity_name, basedOn };
}

export function listApprovals(status?: string): Approval[] {
  ensure();
  const q = status
    ? getDB().prepare('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC').all(status)
    : getDB().prepare("SELECT * FROM approvals ORDER BY (status='pending') DESC, created_at DESC").all();
  return q as Approval[];
}

/** Approve a proposal. Execution is wired later (connectors); for now records intent. */
export function approve(id: number): void {
  ensure();
  getDB().prepare("UPDATE approvals SET status='approved', decided_at=? WHERE id=? AND status='pending'").run(Date.now(), id);
  audit('approved', id, '');
  emitChanged();
}

export function reject(id: number): void {
  ensure();
  getDB().prepare("UPDATE approvals SET status='rejected', decided_at=? WHERE id=? AND status='pending'").run(Date.now(), id);
  audit('rejected', id, '');
  emitChanged();
}

/** Called after a connector actually runs the approved action. */
export function recordExecution(id: number, ok: boolean, result: string): void {
  ensure();
  getDB().prepare('UPDATE approvals SET status=?, result=? WHERE id=?').run(ok ? 'executed' : 'failed', result, id);
  audit(ok ? 'executed' : 'failed', id, result.slice(0, 500));
  emitChanged();
}

export function listAudit(limit = 200): { id: number; ts: number; action: string; approval_id: number | null; detail: string | null }[] {
  ensure();
  return getDB().prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?').all(limit) as {
    id: number;
    ts: number;
    action: string;
    approval_id: number | null;
    detail: string | null;
  }[];
}
