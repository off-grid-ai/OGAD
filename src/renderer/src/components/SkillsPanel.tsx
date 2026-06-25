import { useEffect, useState } from 'react';

// Right-side panel to view, create, edit, and delete Skills — reusable
// instruction packs invoked from chat with /skill-name. Mirrors the ArtifactCanvas
// panel: fixed to the right, brutalist/emerald, fully on-device.

type TriggerKind = '' | 'schedule' | 'keyword' | 'event';
type Draft = {
  name: string;
  description: string;
  instructions: string;
  originalName?: string;
  // Automation (UI-flat; converted to the discriminated trigger on save):
  triggerKind: TriggerKind;
  triggerConfig: string; // schedule: 'HH:MM' · keyword: 'a, b' · event: 'calendar'|'approval'
  action: string;
  connectors: boolean;
};

const BLANK: Draft = { name: '', description: '', instructions: '', triggerKind: '', triggerConfig: '', action: '', connectors: true };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flattenTrigger(full: any): Pick<Draft, 'triggerKind' | 'triggerConfig' | 'action' | 'connectors'> {
  const t = full?.trigger;
  if (!t) return { triggerKind: '', triggerConfig: '', action: '', connectors: true };
  const action = typeof full.action === 'string' ? full.action : '';
  const connectors = full.connectors !== false;
  if (t.kind === 'schedule') return { triggerKind: 'schedule', triggerConfig: t.at || '08:00', action, connectors };
  if (t.kind === 'keyword') return { triggerKind: 'keyword', triggerConfig: (t.keywords || []).join(', '), action, connectors };
  if (t.kind === 'event') return { triggerKind: 'event', triggerConfig: t.on || 'calendar', action, connectors };
  return { triggerKind: '', triggerConfig: '', action, connectors };
}

function buildTrigger(d: Draft): { kind: 'schedule'; at: string } | { kind: 'keyword'; keywords: string[] } | { kind: 'event'; on: 'calendar' | 'approval' } | null {
  if (d.triggerKind === 'schedule') return { kind: 'schedule', at: /^\d{1,2}:\d{2}$/.test(d.triggerConfig.trim()) ? d.triggerConfig.trim() : '08:00' };
  if (d.triggerKind === 'keyword') return { kind: 'keyword', keywords: d.triggerConfig.split(',').map((s) => s.trim()).filter(Boolean) };
  if (d.triggerKind === 'event') return { kind: 'event', on: d.triggerConfig === 'approval' ? 'approval' : 'calendar' };
  return null;
}

export function SkillsPanel({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  // Skill automation (triggers) is Pro; the free build shows manual packs only.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isProBuild = !!(window as any).api?.isPro;
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = (): void => {
    window.api.listSkills?.().then((s) => setSkills(s || [])).catch(() => setSkills([]));
  };
  useEffect(refresh, []);

  const openSkill = async (name: string): Promise<void> => {
    const full = await window.api.getSkill?.(name);
    if (full) setDraft({ name: full.name, description: full.description, instructions: full.instructions, originalName: full.name, ...flattenTrigger(full) });
  };

  const save = async (): Promise<void> => {
    if (!draft || !draft.name.trim()) return;
    setBusy(true);
    try {
      await window.api.saveSkill?.({
        name: draft.name,
        description: draft.description,
        instructions: draft.instructions,
        originalName: draft.originalName,
        trigger: buildTrigger(draft),
        action: draft.action,
        connectors: draft.connectors,
      });
      refresh();
      onChanged?.();
      setDraft(null);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!draft?.originalName) { setDraft(null); return; }
    setBusy(true);
    try {
      await window.api.deleteSkill?.(draft.originalName);
      refresh();
      onChanged?.();
      setDraft(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed right-0 top-0 bottom-0 z-50 flex w-[30vw] min-w-[420px] flex-col border-l border-neutral-800 bg-neutral-950 font-mono shadow-2xl">
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm text-neutral-200">
          <span className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-green-500">Skills</span>
          <span className="truncate">{draft ? (draft.originalName || 'New skill') : `${skills.length} installed`}</span>
        </div>
        <div className="flex items-center gap-2">
          {!draft && (
            <button onClick={() => setDraft({ ...BLANK })} className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-300 transition-colors hover:border-green-500 hover:text-green-500">New skill</button>
          )}
          <button onClick={onClose} className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-300 transition-colors hover:text-white">Close</button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {draft ? (
          <div className="flex flex-col gap-3">
            <label className="text-[10px] uppercase tracking-wide text-neutral-500">Name <span className="text-neutral-600">(invoke with /name)</span></label>
            <input
              autoFocus
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="proofread"
              className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-green-500"
            />
            <label className="text-[10px] uppercase tracking-wide text-neutral-500">Description</label>
            <input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="What this skill does (shown in the / menu)"
              className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-green-500"
            />
            <label className="text-[10px] uppercase tracking-wide text-neutral-500">Instructions</label>
            <textarea
              value={draft.instructions}
              onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
              placeholder="The instructions the model follows when this skill is invoked…"
              rows={14}
              className="resize-none rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm leading-relaxed text-neutral-200 placeholder-neutral-600 outline-none focus:border-green-500"
            />

            {/* Automation (trigger → action) is a Pro feature — hidden in the free
                build, which has manual /skill packs only. */}
            {isProBuild && (<>
            <div className="mt-2 rounded-md border border-neutral-800 bg-neutral-900/30 p-3">
              <label className="text-[10px] uppercase tracking-wide text-neutral-500">Automation <span className="text-neutral-600">(optional — run this skill on its own)</span></label>
              <select
                value={draft.triggerKind}
                onChange={(e) => setDraft({ ...draft, triggerKind: e.target.value as TriggerKind })}
                className="mt-2 w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-green-500"
              >
                <option value="">Manual only (invoke with /name)</option>
                <option value="schedule">On a schedule (daily)</option>
                <option value="keyword">When a keyword is captured</option>
                <option value="event">On a new event</option>
              </select>

              {draft.triggerKind === 'schedule' && (
                <input
                  value={draft.triggerConfig}
                  onChange={(e) => setDraft({ ...draft, triggerConfig: e.target.value })}
                  placeholder="08:00"
                  className="mt-2 w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-green-500"
                />
              )}
              {draft.triggerKind === 'keyword' && (
                <input
                  value={draft.triggerConfig}
                  onChange={(e) => setDraft({ ...draft, triggerConfig: e.target.value })}
                  placeholder="invoice, payment, contract"
                  className="mt-2 w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-green-500"
                />
              )}
              {draft.triggerKind === 'event' && (
                <select
                  value={draft.triggerConfig || 'calendar'}
                  onChange={(e) => setDraft({ ...draft, triggerConfig: e.target.value })}
                  className="mt-2 w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-green-500"
                >
                  <option value="calendar">New calendar event</option>
                  <option value="approval">New approval</option>
                </select>
              )}

              {draft.triggerKind && (
                <>
                  <label className="mt-3 block text-[10px] uppercase tracking-wide text-neutral-500">Action <span className="text-neutral-600">(what to do when it fires)</span></label>
                  <textarea
                    value={draft.action}
                    onChange={(e) => setDraft({ ...draft, action: e.target.value })}
                    placeholder="Summarize the new invoice and draft a reply to send for approval…"
                    rows={3}
                    className="mt-2 w-full resize-none rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm leading-relaxed text-neutral-200 placeholder-neutral-600 outline-none focus:border-green-500"
                  />
                  <label className="mt-2 flex items-center gap-2 text-xs text-neutral-400">
                    <input type="checkbox" checked={draft.connectors} onChange={(e) => setDraft({ ...draft, connectors: e.target.checked })} className="accent-green-500" />
                    Let it use connectors (writes still require your approval)
                  </label>
                </>
              )}
            </div>
            </>)}

            <div className="mt-1 flex items-center justify-between">
              <div className="flex gap-2">
                <button disabled={busy || !draft.name.trim()} onClick={save} className="rounded-md bg-green-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-green-500 disabled:opacity-40">Save</button>
                <button onClick={() => setDraft(null)} className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 transition-colors hover:text-neutral-200">Cancel</button>
              </div>
              {draft.originalName && (
                <button disabled={busy} onClick={remove} className="rounded-md border border-red-500/40 px-3 py-1.5 text-xs text-red-400 transition-colors hover:bg-red-500/10">Delete</button>
              )}
            </div>
          </div>
        ) : skills.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-neutral-600">
            <p className="text-sm">No skills yet.</p>
            <button onClick={() => setDraft({ ...BLANK })} className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:border-green-500 hover:text-green-500">Create your first skill</button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {skills.map((s) => (
              <button
                key={s.name}
                onClick={() => openSkill(s.name)}
                className="flex flex-col items-start gap-0.5 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2.5 text-left transition-colors hover:border-green-500/60"
              >
                <span className="text-sm text-green-500">/{s.name}</span>
                {s.description ? <span className="text-xs text-neutral-500">{s.description}</span> : null}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
