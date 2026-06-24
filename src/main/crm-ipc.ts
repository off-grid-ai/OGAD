// IPC for the CRM-for-everything layer: entity records (Entity -> App -> frames),
// search, and the correction/resolution surface (rename / retype / alias / merge /
// split + the merge-suggestion review queue).

import { ipcMain, dialog, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { getEntityRecord, getObservationFrames, searchObservations, listEntitiesWithActivity } from './crm/record';
import { universalSearch, searchStatus, searchSources, runBackfill } from './search';
import { getDayActivity, getDayJournal, getStoredDayJournal } from './crm/day';
import { listReplayFrames, defaultReplayDayStartSec } from './crm/replay';
import { getDayReflection, getWeekReflection } from './crm/reflect';
import { listActionItems, setActionItemStatus } from './crm/actions';
import { getIdentity, setIdentity, type Identity } from './identity';
import { secretsAvailable, setSecret, deleteSecret, listSecretKeys } from './secrets';
import { proposeApproval, listApprovals, getApproval, getApprovalProvenance, approve, reject, recordExecution, listAudit } from './crm/approvals';
import { recordFeedback, getPreferences, setPreferences, distillPreferences } from './crm/preferences';
import { setSelfView } from './focus';
import { listConnectors, addConnector, setConnectorEnabled, removeConnector, testConnector, callConnectorTool, type NewConnector } from './mcp';
import { ingestConnector, listConnectorItems } from './ingest';
import { saveMeeting, listMeetings, deleteMeeting } from './meetings';
import { startMeetingRecording, stopMeetingRecording } from './meeting-native';
import { meetingActive } from './meeting-detect';
import { getAhead, getEventPrep, getDayPlan, getDayPlanCached } from './crm/ahead';
import { proposeActions } from './crm/agent';
import { backfillFromMemories } from './crm/observations';
import {
  renameEntity,
  retypeEntity,
  addAlias,
  removeAlias,
  setEntityPhoto,
  setEntityParent,
  setEntityHidden,
  unlinkObservationFromEntity,
  reassignObservation,
  deleteObservation,
  getChildren,
  mergeEntities,
  splitObservations,
  listMergeSuggestions,
  dismissMergeSuggestion,
  type IdentifierKind,
} from './crm/resolve';
import { organizeEntities } from './crm/organize';
import { summarizeEntity } from './crm/synthesize';

export function setupCrmIPC(): void {
  // One-time: seed observations from already-captured memories (deferred so it
  // never blocks startup; no-op once observations exist).
  setTimeout(() => {
    try {
      const n = backfillFromMemories();
      if (n > 0) console.log(`[CRM] Backfilled ${n} observations from existing memories.`);
    } catch (e) {
      console.error('[CRM] Backfill failed:', e);
    }
  }, 2500);

  ipcMain.handle('crm:backfill', () => backfillFromMemories());

  // Records + feed + frames
  ipcMain.handle('crm:list-entities', () => listEntitiesWithActivity());
  ipcMain.handle('crm:entity-record', (_e, entityId: number, opts?: { surface?: string; limit?: number }) =>
    getEntityRecord(entityId, opts ?? {})
  );
  ipcMain.handle('crm:observation-frames', (_e, observationId: number) => getObservationFrames(observationId));
  ipcMain.handle('crm:search', (_e, query: string, entityId?: number) => searchObservations(query, entityId));
  // Universal search — hybrid keyword (FTS5) + semantic (LanceDB) across everything.
  ipcMain.handle('search:universal', (_e, query: string, opts?: { limit?: number; semantic?: boolean; sources?: string[] }) =>
    universalSearch(query, opts ?? {})
  );
  ipcMain.handle('search:status', () => searchStatus());
  ipcMain.handle('search:sources', () => searchSources());
  ipcMain.handle('search:reindex', () => runBackfill());
  ipcMain.handle('crm:day-activity', (_e, startSec: number, endSec: number) => getDayActivity(startSec, endSec));
  ipcMain.handle('crm:day-journal', (_e, startSec: number, endSec: number) => getDayJournal(startSec, endSec));
  ipcMain.handle('crm:day-journal-cached', (_e, startSec: number) => getStoredDayJournal(startSec));
  ipcMain.handle('crm:replay-frames', (_e, startSec: number, endSec: number) => listReplayFrames(startSec, endSec));
  ipcMain.handle('crm:replay-default-day', () => defaultReplayDayStartSec());
  ipcMain.handle('crm:day-reflection', (_e, startSec: number, endSec: number) => getDayReflection(startSec, endSec));
  ipcMain.handle('crm:week-reflection', (_e, anchorDayStartSec: number) => getWeekReflection(anchorDayStartSec));
  ipcMain.handle('crm:list-actions', () => listActionItems());
  ipcMain.handle('crm:set-action-status', (_e, id: number, status: 'open' | 'done' | 'dismissed') => setActionItemStatus(id, status));

  // --- Act-pillar foundation: identity, secrets, approvals ---
  ipcMain.handle('id:get', () => getIdentity());
  ipcMain.handle('id:set', (_e, id: Partial<Identity>) => setIdentity(id));

  ipcMain.handle('secrets:available', () => secretsAvailable());
  ipcMain.handle('secrets:set', (_e, key: string, value: string) => setSecret(key, value));
  ipcMain.handle('secrets:delete', (_e, key: string) => deleteSecret(key));
  ipcMain.handle('secrets:list-keys', () => listSecretKeys());

  ipcMain.handle('approvals:propose', (_e, p: Parameters<typeof proposeApproval>[0]) => proposeApproval(p));
  ipcMain.handle('approvals:list', (_e, status?: string) => listApprovals(status));
  ipcMain.handle('approvals:provenance', (_e, id: number) => getApprovalProvenance(id));
  ipcMain.handle('approvals:approve', async (_e, id: number) => {
    approve(id);
    // If the approval names a connector tool, execute it now (the ONLY path that
    // acts — and only after the user approved). Result is recorded + audited.
    const a = getApproval(id);
    if (a?.connector && a.tool) {
      const connectorId = Number(a.connector);
      const args = a.args ? JSON.parse(a.args) : {};
      const res = await callConnectorTool(connectorId, a.tool, args);
      recordExecution(id, res.ok, res.ok ? JSON.stringify(res.result).slice(0, 1000) : res.error ?? 'failed');
    }
  });
  ipcMain.handle('approvals:reject', (_e, id: number, reason?: string) => {
    const a = getApproval(id);
    reject(id);
    if (reason && reason.trim() && a) {
      recordFeedback({ approvalId: id, title: a.title, connector: a.connector, tool: a.tool, entityName: a.entity_name, reason });
    }
  });
  ipcMain.handle('capture:self-view', (_e, view: string) => setSelfView(view));
  ipcMain.handle('secretary:prefs:get', () => getPreferences());
  ipcMain.handle('secretary:prefs:set', (_e, doc: string) => setPreferences(doc ?? ''));
  ipcMain.handle('secretary:prefs:distill', () => distillPreferences());
  ipcMain.handle('approvals:audit', (_e, limit?: number) => listAudit(limit));

  // --- MCP connectors ---
  ipcMain.handle('mcp:list', () => listConnectors());
  ipcMain.handle('mcp:add', (_e, c: NewConnector) => addConnector(c));
  ipcMain.handle('mcp:set-enabled', (_e, id: number, enabled: boolean) => setConnectorEnabled(id, enabled));
  ipcMain.handle('mcp:remove', (_e, id: number) => removeConnector(id));
  ipcMain.handle('mcp:test', (_e, id: number) => testConnector(id));
  ipcMain.handle('mcp:call', (_e, id: number, tool: string, args: unknown) => callConnectorTool(id, tool, args));
  ipcMain.handle('mcp:ingest', (_e, id: number, query?: string) => ingestConnector(id, query));

  // --- Meeting recorder ---
  ipcMain.handle('meeting:save', (_e, audio: Uint8Array, meta: { startedAt: number; endedAt: number; ext?: string }) => saveMeeting(audio, meta));
  // Native recorder: screen video + system audio (the far side) + mic, captured
  // by the bundled Swift binary — routing-independent, nothing for the user to do.
  ipcMain.handle('meeting:start', (_e, platform?: string) => startMeetingRecording(platform));
  ipcMain.handle('meeting:stop', () => stopMeetingRecording());
  // Current detection state — the renderer queries this on mount so it auto-records
  // a call that was already in progress when the window loaded (the detector's
  // edge-broadcast can fire before the renderer is listening).
  ipcMain.handle('meeting:get-state', () => meetingActive());
  ipcMain.handle('meeting:list', () => listMeetings());
  ipcMain.handle('meeting:delete', (_e, id: number) => deleteMeeting(id));
  ipcMain.handle('mcp:items', (_e, surface: string) => listConnectorItems(surface));

  // --- Ahead (prospective Day) ---
  ipcMain.handle('crm:ahead', (_e, nowSec?: number) => getAhead(nowSec ?? Math.floor(Date.now() / 1000)));
  ipcMain.handle('crm:event-prep', (_e, title: string, attendees: string[]) => getEventPrep(title, attendees ?? []));
  ipcMain.handle('crm:day-plan', (_e, nowSec?: number) => getDayPlan(nowSec ?? Math.floor(Date.now() / 1000)));
  ipcMain.handle('crm:day-plan-cached', (_e, nowSec?: number) => getDayPlanCached(nowSec ?? Math.floor(Date.now() / 1000)));
  // The secretary: survey connected tools + context → propose actions to approve.
  ipcMain.handle('crm:propose-actions', (_e, nowSec?: number) => proposeActions(nowSec ?? Math.floor(Date.now() / 1000)));

  // Corrections (durable)
  ipcMain.handle('crm:rename-entity', (_e, id: number, name: string) => renameEntity(id, name));
  ipcMain.handle('crm:retype-entity', (_e, id: number, type: string) => retypeEntity(id, type));
  ipcMain.handle('crm:add-alias', (_e, id: number, kind: IdentifierKind, value: string) => addAlias(id, kind, value));
  ipcMain.handle('crm:remove-alias', (_e, aliasId: number) => removeAlias(aliasId));

  // Entity photo: pick an image, copy into userData/entity-photos, set the path.
  ipcMain.handle('crm:set-entity-photo', async (e, id: number) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const res = await dialog.showOpenDialog(win!, {
      title: 'Choose a photo',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const src = res.filePaths[0];
    const dir = path.join(app.getPath('userData'), 'entity-photos');
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(src) || '.png';
    const dst = path.join(dir, `entity-${id}${ext}`);
    try {
      fs.copyFileSync(src, dst);
      setEntityPhoto(id, dst);
      return dst;
    } catch (err) {
      console.error('[CRM] set photo failed:', err);
      return null;
    }
  });
  ipcMain.handle('crm:clear-entity-photo', (_e, id: number) => setEntityPhoto(id, null));
  ipcMain.handle('crm:merge-entities', (_e, keepId: number, mergeId: number) => mergeEntities(keepId, mergeId));
  ipcMain.handle('crm:split-observations', (_e, observationIds: number[], toName: string, toType?: string) =>
    splitObservations(observationIds, toName, toType)
  );

  // Hierarchy + organize
  ipcMain.handle('crm:set-parent', (_e, childId: number, parentId: number | null) => setEntityParent(childId, parentId));
  ipcMain.handle('crm:set-hidden', (_e, id: number, hidden: boolean) => setEntityHidden(id, hidden));
  ipcMain.handle('crm:unlink-observation', (_e, obsId: number, entityId: number) => unlinkObservationFromEntity(obsId, entityId));
  ipcMain.handle('crm:reassign-observation', (_e, obsId: number, fromEntityId: number, toName: string, toType?: string) =>
    reassignObservation(obsId, fromEntityId, toName, toType)
  );
  ipcMain.handle('crm:delete-observation', (_e, obsId: number) => deleteObservation(obsId));
  ipcMain.handle('crm:children', (_e, parentId: number) => getChildren(parentId));
  ipcMain.handle('crm:organize', () => organizeEntities());
  ipcMain.handle('crm:summarize-entity', (_e, id: number) => summarizeEntity(id));

  // Review queue
  ipcMain.handle('crm:merge-suggestions', () => listMergeSuggestions());
  ipcMain.handle('crm:dismiss-suggestion', (_e, id: number) => dismissMergeSuggestion(id));
}
