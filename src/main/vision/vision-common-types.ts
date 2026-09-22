/** Shared observations consumed by the vision graph and model adapters. */
export interface VisionSemanticElement {
  index: number
  role: string
  name: string
  value: string
  point: { x: number; y: number }
  /** True only when this fresh native observation can execute the control. */
  actionable?: boolean
}

export type VisionActionEffect = 'confirmed' | 'suspected_noop' | 'unverifiable'
