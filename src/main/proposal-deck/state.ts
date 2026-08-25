export type ProposalSaleMode = 'transformation' | 'product-engineering'
export type ProposalGeography = 'india' | 'international'

export type ProposalStage =
  | 'website_research'
  | 'narrative_plan'
  | 'narrative_approval'
  | 'skeleton'
  | 'skeleton_approval'
  | 'case_studies'
  | 'case_study_selection'
  | 'full_copy'
  | 'full_copy_approval'
  | 'complete'

export interface ProposalCaseStudy {
  label: string
  relevance: string
  metrics: string[]
}

export interface ProposalIllustration {
  slide: number
  prompt: string
  orientation: 'portrait' | 'landscape'
}

export interface ProposalSession {
  version: 2
  conversationId: string
  company: string
  brief: string
  saleMode: ProposalSaleMode
  geography: ProposalGeography
  website?: string
  sourceFolder: string
  styleFolder?: string
  outputRoot: string
  outputDir: string
  stage: ProposalStage
  caseStudies: ProposalCaseStudy[]
  selectedCaseStudies: ProposalCaseStudy[]
  illustrations: ProposalIllustration[]
  createdAt: string
  updatedAt: string
}

export type ProposalTransition =
  | { kind: 'save_website_context' }
  | { kind: 'save_narrative_plan' }
  | { kind: 'revise_narrative_plan' }
  | { kind: 'approve_narrative_plan' }
  | { kind: 'save_skeleton' }
  | { kind: 'revise_skeleton' }
  | { kind: 'approve_skeleton' }
  | { kind: 'save_case_studies'; caseStudies: ProposalCaseStudy[] }
  | { kind: 'select_case_studies'; selectedLabels: string[] }
  | { kind: 'save_full_copy'; illustrations: ProposalIllustration[] }
  | { kind: 'revise_full_copy'; illustrations: ProposalIllustration[] }
  | { kind: 'regenerate_illustration'; illustration: ProposalIllustration }
  | { kind: 'approve_full_copy' }

const EXPECTED_STAGE: Record<ProposalTransition['kind'], ProposalStage> = {
  save_website_context: 'website_research',
  save_narrative_plan: 'narrative_plan',
  revise_narrative_plan: 'narrative_approval',
  approve_narrative_plan: 'narrative_approval',
  save_skeleton: 'skeleton',
  revise_skeleton: 'skeleton_approval',
  approve_skeleton: 'skeleton_approval',
  save_case_studies: 'case_studies',
  select_case_studies: 'case_study_selection',
  save_full_copy: 'full_copy',
  revise_full_copy: 'full_copy_approval',
  regenerate_illustration: 'full_copy_approval',
  approve_full_copy: 'full_copy_approval'
}

const NEXT_STAGE: Record<ProposalTransition['kind'], ProposalStage> = {
  save_website_context: 'narrative_plan',
  save_narrative_plan: 'narrative_approval',
  revise_narrative_plan: 'narrative_approval',
  approve_narrative_plan: 'skeleton',
  save_skeleton: 'skeleton_approval',
  revise_skeleton: 'skeleton_approval',
  approve_skeleton: 'case_studies',
  save_case_studies: 'case_study_selection',
  select_case_studies: 'full_copy',
  save_full_copy: 'full_copy_approval',
  revise_full_copy: 'full_copy_approval',
  regenerate_illustration: 'full_copy_approval',
  approve_full_copy: 'complete'
}

export function validateCaseStudy(study: ProposalCaseStudy): string | null {
  if (!study.label.trim()) return 'Each case study needs a label.'
  if (!study.relevance.trim()) return `${study.label} needs a relevance reason.`
  if (study.metrics.length < 3 || study.metrics.some((metric) => !metric.trim())) {
    return `${study.label} needs three confirmed outcome metrics.`
  }
  return null
}

export function isExplicitProposalApproval(input: string): boolean {
  return /\b(approve|approved|looks good|sign off|go ahead|yes,? proceed)\b/i.test(input.trim())
}

function validateRankedCaseStudies(caseStudies: ProposalCaseStudy[]): void {
  if (caseStudies.length < 3 || caseStudies.length > 4) {
    throw new Error('Rank three or four case studies before selection.')
  }
  for (const study of caseStudies) {
    const error = validateCaseStudy(study)
    if (error) throw new Error(error)
  }
}

function selectCaseStudies(
  session: ProposalSession,
  selectedLabels: string[]
): ProposalCaseStudy[] {
  const labels = new Set(selectedLabels.map((label) => label.trim().toLowerCase()))
  if (labels.size !== 2) throw new Error('Select exactly two case studies.')
  const selected = session.caseStudies.filter((study) => labels.has(study.label.toLowerCase()))
  if (selected.length !== 2) throw new Error('Both selections must come from the ranked list.')
  for (const study of selected) {
    const error = validateCaseStudy(study)
    if (error) throw new Error(error)
  }
  return selected
}

function validateIllustrations(illustrations: ProposalIllustration[]): void {
  const slides = illustrations.map((illustration) => illustration.slide)
  if (slides.some((slide) => !Number.isInteger(slide) || slide < 1 || slide > 12)) {
    throw new Error('Illustration slide numbers must be between 1 and 12.')
  }
  if (new Set(slides).size !== slides.length) {
    throw new Error('Each slide can have only one illustration.')
  }
  if (illustrations.some((item) => typeof item.prompt !== 'string' || !item.prompt.trim())) {
    throw new Error('Each illustration needs a complete prompt.')
  }
  if (illustrations.some((item) => !['portrait', 'landscape'].includes(item.orientation))) {
    throw new Error('Each illustration needs a portrait or landscape orientation.')
  }
}

function replaceIllustration(
  current: ProposalIllustration[],
  replacement: ProposalIllustration
): ProposalIllustration[] {
  validateIllustrations([replacement])
  if (!current.some((illustration) => illustration.slide === replacement.slide)) {
    throw new Error('Regenerate an illustration already assigned to this slide.')
  }
  return current.map((illustration) =>
    illustration.slide === replacement.slide ? replacement : illustration
  )
}

export function advanceProposal(
  session: ProposalSession,
  transition: ProposalTransition,
  now = new Date().toISOString()
): ProposalSession {
  const expected = EXPECTED_STAGE[transition.kind]
  if (session.stage !== expected) {
    throw new Error(`This proposal is at ${session.stage}. Expected ${expected}.`)
  }

  if (transition.kind === 'save_case_studies') validateRankedCaseStudies(transition.caseStudies)

  if (transition.kind === 'select_case_studies') {
    const selected = selectCaseStudies(session, transition.selectedLabels)
    return {
      ...session,
      selectedCaseStudies: selected,
      stage: NEXT_STAGE[transition.kind],
      updatedAt: now
    }
  }

  if (transition.kind === 'save_full_copy' || transition.kind === 'revise_full_copy') {
    validateIllustrations(transition.illustrations)
  }

  if (transition.kind === 'regenerate_illustration') {
    return {
      ...session,
      illustrations: replaceIllustration(session.illustrations, transition.illustration),
      updatedAt: now
    }
  }

  return {
    ...session,
    ...(transition.kind === 'save_case_studies' ? { caseStudies: transition.caseStudies } : {}),
    ...(transition.kind === 'save_full_copy' || transition.kind === 'revise_full_copy'
      ? { illustrations: transition.illustrations }
      : {}),
    stage: NEXT_STAGE[transition.kind],
    updatedAt: now
  }
}

export function proposalNextInstruction(stage: ProposalStage): string {
  switch (stage) {
    case 'website_research':
      return 'Use web_task on the supplied public website. Save only factual client context with proposal_deck save_website_context.'
    case 'narrative_plan':
      return 'Write the Narrative Plan only. Then call proposal_deck with save_narrative_plan. Do not write slide titles.'
    case 'narrative_approval':
      return 'Wait for explicit approval or revision feedback. Call approve_narrative_plan only after approval.'
    case 'skeleton':
      return 'Write the slide skeleton, with a title of six words or fewer and one communication goal per slide. Then save it.'
    case 'skeleton_approval':
      return 'Wait for explicit skeleton approval or revision feedback.'
    case 'case_studies':
      return 'Rank three or four relevant case studies. Never invent metrics. Then save the ranked list.'
    case 'case_study_selection':
      return 'Wait for the user to select exactly two case studies.'
    case 'full_copy':
      return 'Write the full copy for no more than 12 slides. Include local-image prompts only for layouts that need an illustration. Then save it.'
    case 'full_copy_approval':
      return 'Wait for explicit final approval. Revise individual slides without changing approved slides.'
    case 'complete':
      return 'The proposal is complete. Report the output folder and files.'
  }
}
