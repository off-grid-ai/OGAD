/** Shared observations consumed by the vision graph and model adapters. */
export interface VisionSemanticElement {
  index: number
  role: string
  name: string
  value: string
  point: { x: number; y: number }
}

export type VisionActionEffect = 'confirmed' | 'suspected_noop' | 'unverifiable'
