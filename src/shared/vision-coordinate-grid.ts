export const NORMALIZED_COORDINATE_GRID_INSTRUCTION =
  'The screenshot has a faint coordinate grid labeled from 0 to 1000 on both axes. Use those labels as the coordinate reference for this exact image.'

/**
 * The colours the coordinate grid and the click marker are drawn in.
 *
 * These are NOT theme colours, and they were the boundary violation: the policy runner imported
 * `COLORS_LIGHT` and `COLORS_DARK` from `@offgrid/design`, which put a main-process image
 * annotation on the design system. Two problems, and the second is the real one.
 *
 * The boundary: main has no theme and should not know there is one. Nothing here is shown to a
 * person - the grid and the marker are composited onto a screenshot that goes to the VISION MODEL,
 * and the only requirement is that the model can read them against arbitrary screen content.
 *
 * The correctness: a design token that tracked the user's theme would mean switching to light mode
 * changes what the model sees, and a brand palette change would silently alter grounding
 * behaviour. The old code already gave that away by pairing `COLORS_DARK.primary` with
 * `COLORS_LIGHT.background` in one marker - a hand-picked contrast pair wearing theme names.
 *
 * So they are fixed, named, and owned here beside the instruction that describes the grid to the
 * model. They happen to start at the same values the palette had, which is deliberate: this change
 * alters no pixel the model receives.
 */
export const VISION_ANNOTATION_COLORS = {
  /** Grid lines. Faint, drawn at low opacity over the frame. */
  grid: '#059669',
  /** Axis labels, the darker tone so small text stays legible on light content. */
  gridLabel: '#047857',
  /** The halo behind labels and around the marker, for contrast on dark content. */
  halo: '#FFFFFF',
  /** The click marker's fill. The lighter tone, to read against dark UI. */
  marker: '#34D399'
} as const
