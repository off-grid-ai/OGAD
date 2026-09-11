export { parseArtifact } from '@offgrid/artifacts'

/** Desktop compatibility shape until all callers import the Shared contract directly. */
export type Artifact = import('@offgrid/artifacts').Artifact & { readonly title?: string }
