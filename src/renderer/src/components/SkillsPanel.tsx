import { useEffect, useState } from 'react';

// Right-side panel to view, create, edit, and delete Skills — reusable
// instruction packs invoked from chat with /skill-name. Mirrors the ArtifactCanvas
// panel: fixed to the right, brutalist/emerald, fully on-device.

type Draft = { name: string; description: string; instructions: string; originalName?: string };

const BLANK: Draft = { name: '', description: '', instructions: '' };

export function SkillsPanel({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = (): void => {
    window.api.listSkills?.().then((s) => setSkills(s || [])).catch(() => setSkills([]));
  };
  useEffect(refresh, []);

  const openSkill = async (name: string): Promise<void> => {
    const full = await window.api.getSkill?.(name);
    if (full) setDraft({ ...full, originalName: full.name });
  };

  const save = async (): Promise<void> => {
    if (!draft || !draft.name.trim()) return;
    setBusy(true);
    try {
      await window.api.saveSkill?.(draft);
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
    <div className="fixed right-0 top-0 bottom-0 z-50 flex w-[44vw] min-w-[420px] flex-col border-l border-neutral-800 bg-neutral-950 font-mono shadow-2xl">
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
