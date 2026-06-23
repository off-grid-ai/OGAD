// Canvas / artifacts runtime — serves the bundled, offline sandbox libraries
// (React UMD, Babel-standalone, Mermaid) to the renderer so model-generated
// HTML / React / SVG / Mermaid artifacts render in a sandboxed iframe with no
// network access. Libs live in resources/artifacts (no CDN).

import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';

function artifactsDir(): string {
  const roots = app.isPackaged
    ? [path.join(process.resourcesPath, 'artifacts')]
    : [path.join(app.getAppPath(), 'resources', 'artifacts'), path.join(process.cwd(), 'resources', 'artifacts')];
  for (const r of roots) {
    if (fs.existsSync(r)) return r;
  }
  return roots[0];
}

function read(name: string): string {
  try {
    return fs.readFileSync(path.join(artifactsDir(), name), 'utf8');
  } catch {
    return '';
  }
}

// 'text' and 'image' are uploaded INPUTS (files / pasted blocks / images the user
// attached), catalogued alongside model-generated artifacts so a chat's/project's
// whole working set — inputs and outputs — lives in one place. For 'text' the code
// is the document body; for 'image' it's the on-disk path. Neither is sandboxed.
export type ArtifactKind = 'html' | 'svg' | 'mermaid' | 'react' | 'text' | 'image';

/** Return only the runtime libs an artifact kind needs (kept off the wire otherwise). */
export function artifactRuntime(kind: ArtifactKind): Record<string, string> {
  if (kind === 'mermaid') return { mermaid: read('mermaid.min.js') };
  if (kind === 'react') {
    return { react: read('react.min.js'), reactDom: read('react-dom.min.js'), babel: read('babel.min.js') };
  }
  return {}; // html / svg / text need no libs
}

// ─── Artifact library (persisted on-device, browsable in the gallery) ─────────
// Model-generated artifacts are saved to userData/artifacts-library as small JSON
// records so they can be revisited, re-rendered, downloaded, or deleted later —
// the same way generated images persist under userData/generated-images.

export interface SavedArtifact {
  id: string;
  kind: ArtifactKind;
  code: string;
  title: string;
  created: number;
  conversationId?: string;
  projectId?: string | null;
}

function libraryDir(): string {
  const d = path.join(app.getPath('userData'), 'artifacts-library');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** A human label for an artifact, pulled from its content when possible. */
function deriveTitle(kind: ArtifactKind, code: string): string {
  if (kind === 'html') {
    const t = /<title[^>]*>([^<]+)<\/title>/i.exec(code)?.[1] || /<h1[^>]*>([^<]+)<\/h1>/i.exec(code)?.[1];
    if (t) return t.trim().slice(0, 80);
  }
  if (kind === 'mermaid') return code.split('\n')[0].replace(/^\s*%%.*/, '').trim().slice(0, 60) || 'Diagram';
  if (kind === 'react') {
    const fn = /function\s+([A-Za-z0-9_]+)/.exec(code)?.[1];
    if (fn && fn !== 'App') return fn;
  }
  return { html: 'HTML page', svg: 'SVG graphic', mermaid: 'Diagram', react: 'React component', text: 'Document', image: 'Image' }[kind];
}

/** Persist an artifact (deduped by content + chat). Returns the saved record. */
export function saveArtifact(a: { kind: ArtifactKind; code: string; title?: string; conversationId?: string; projectId?: string | null }): SavedArtifact {
  // Scope into the id so the same code in different chats are distinct records.
  const id = createHash('sha1').update(`${a.kind}\n${a.conversationId || ''}\n${a.code}`).digest('hex').slice(0, 16);
  const file = path.join(libraryDir(), `${id}.json`);
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as SavedArtifact;
    } catch {
      /* corrupt — overwrite below */
    }
  }
  const rec: SavedArtifact = {
    id,
    kind: a.kind,
    code: a.code,
    title: (a.title || deriveTitle(a.kind, a.code)).trim(),
    created: Date.now(),
    conversationId: a.conversationId,
    projectId: a.projectId ?? null,
  };
  fs.writeFileSync(file, JSON.stringify(rec));
  return rec;
}

/** Saved artifacts, newest first. Optionally scoped to a chat or a project. */
export function listArtifacts(scope?: { conversationId?: string; projectId?: string | null }): SavedArtifact[] {
  try {
    let all = fs
      .readdirSync(libraryDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(libraryDir(), f), 'utf8')) as SavedArtifact)
      .sort((a, b) => b.created - a.created);
    if (scope?.conversationId) all = all.filter((r) => r.conversationId === scope.conversationId);
    else if (scope?.projectId) all = all.filter((r) => r.projectId === scope.projectId);
    return all;
  } catch {
    return [];
  }
}

/** Delete a saved artifact by id. */
export function deleteArtifact(id: string): boolean {
  try {
    fs.unlinkSync(path.join(libraryDir(), `${path.basename(id)}.json`));
    return true;
  } catch {
    return false;
  }
}
