// Shared renderer types that both core and the pro package reference.

/** A universal-search result. Produced by the pro Search screen; consumed by the
 *  core CommandPalette + navigation handlers, so the shape lives in core. */
export interface SearchHit {
  key: string;
  kind: 'screen' | 'meeting' | 'memory' | 'entity' | 'fact';
  refId: number;
  title: string;
  snippet: string;
  surface: string;
  url: string | null;
  ts: number;
  imagePath: string | null;
  score: number;
}
