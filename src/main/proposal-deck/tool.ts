import { proposalDeckService, type ProposalDeckService } from './service'
import type {
  ProposalCaseStudy,
  ProposalGeography,
  ProposalIllustration,
  ProposalSaleMode,
  ProposalTransition
} from './state'
import { isExplicitProposalApproval } from './state'

export const PROPOSAL_DECK_TOOL_NAME = 'proposal_deck'

export const PROPOSAL_DECK_TOOL = {
  name: PROPOSAL_DECK_TOOL_NAME,
  description:
    'Run the local, gated Wednesday proposal-deck workflow. Use for every turn in an active proposal. It reads only the approved local reference folders, saves each approved stage, and queues illustrations for the installed on-device image model.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'start',
          'status',
          'save_website_context',
          'save_narrative_plan',
          'revise_narrative_plan',
          'approve_narrative_plan',
          'save_skeleton',
          'revise_skeleton',
          'approve_skeleton',
          'save_case_studies',
          'select_case_studies',
          'save_full_copy',
          'revise_full_copy',
          'regenerate_illustration',
          'approve_full_copy'
        ]
      },
      company: { type: 'string' },
      brief: { type: 'string' },
      saleMode: { type: 'string', enum: ['transformation', 'product-engineering'] },
      geography: { type: 'string', enum: ['india', 'international'] },
      website: { type: 'string' },
      sourceFolder: { type: 'string', description: 'User-approved local content folder.' },
      outputFolder: { type: 'string', description: 'User-approved local output folder.' },
      styleFolder: { type: 'string', description: 'Optional local deck used only for style.' },
      content: { type: 'string', description: 'Complete Markdown for the stage being saved.' },
      caseStudies: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            relevance: { type: 'string' },
            metrics: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 }
          },
          required: ['label', 'relevance', 'metrics']
        }
      },
      selectedLabels: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
      illustrations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            slide: { type: 'number' },
            prompt: { type: 'string' },
            orientation: { type: 'string', enum: ['portrait', 'landscape'] }
          },
          required: ['slide', 'prompt', 'orientation']
        }
      },
      illustration: {
        type: 'object',
        description: 'One existing slide illustration to regenerate in place.',
        properties: {
          slide: { type: 'number' },
          prompt: { type: 'string' },
          orientation: { type: 'string', enum: ['portrait', 'landscape'] }
        },
        required: ['slide', 'prompt', 'orientation']
      }
    },
    required: ['action']
  }
} as const

export interface ProposalDeferredImageRequest {
  prompt: string
  proposal: { conversationId: string; slide: number }
}

export interface RunProposalDeckContext {
  conversationId?: string
  userMessage?: string
  service?: ProposalDeckService
}

function transitionFromArgs(args: Record<string, unknown>): ProposalTransition | null {
  const action = String(args.action ?? '')
  const simpleTransitions = new Set<ProposalTransition['kind']>([
    'save_website_context',
    'save_narrative_plan',
    'revise_narrative_plan',
    'approve_narrative_plan',
    'save_skeleton',
    'revise_skeleton',
    'approve_skeleton',
    'approve_full_copy'
  ])
  if (simpleTransitions.has(action as ProposalTransition['kind'])) {
    return { kind: action } as ProposalTransition
  }
  switch (action) {
    case 'save_case_studies':
      return { kind: action, caseStudies: (args.caseStudies ?? []) as ProposalCaseStudy[] }
    case 'select_case_studies':
      return { kind: action, selectedLabels: (args.selectedLabels ?? []) as string[] }
    case 'save_full_copy':
    case 'revise_full_copy':
      return {
        kind: action,
        illustrations: (args.illustrations ?? []) as ProposalIllustration[]
      }
    case 'regenerate_illustration':
      return {
        kind: action,
        illustration: (args.illustration ?? {}) as ProposalIllustration
      }
    default:
      return null
  }
}

async function startProposal(
  args: Record<string, unknown>,
  conversationId: string,
  service: ProposalDeckService
): Promise<{ text: string }> {
  const company = String(args.company ?? '').trim()
  const brief = String(args.brief ?? '').trim()
  const saleMode = String(args.saleMode ?? '') as ProposalSaleMode
  const geography = String(args.geography ?? '') as ProposalGeography
  const sourceFolder = String(args.sourceFolder ?? '').trim()
  const outputFolder = String(args.outputFolder ?? '').trim()
  const missing = [
    { present: company.length > 0, label: 'company name' },
    { present: brief.length > 0, label: 'meeting context and desired outcome' },
    {
      present: ['transformation', 'product-engineering'].includes(saleMode),
      label: 'sale mode'
    },
    { present: ['india', 'international'].includes(geography), label: 'audience geography' },
    { present: sourceFolder.length > 0, label: 'content folder' },
    { present: outputFolder.length > 0, label: 'output folder' }
  ]
    .filter((field) => !field.present)
    .map((field) => field.label)
  if (missing.length) {
    return { text: `Before I start, I need: ${missing.join(', ')}. Ask the user once.` }
  }
  const session = service.start({
    conversationId,
    company,
    brief,
    saleMode,
    geography,
    website: String(args.website ?? ''),
    sourceFolder,
    outputFolder,
    styleFolder: String(args.styleFolder ?? '')
  })
  return { text: await service.context(session) }
}

function isApprovalAction(action: string): boolean {
  return ['approve_narrative_plan', 'approve_skeleton', 'approve_full_copy'].includes(action)
}

function imageRequestsFor(
  transition: ProposalTransition,
  conversationId: string
): ProposalDeferredImageRequest[] | undefined {
  if (transition.kind !== 'save_full_copy' && transition.kind !== 'revise_full_copy') {
    if (transition.kind !== 'regenerate_illustration') return undefined
    return [
      {
        prompt: transition.illustration.prompt,
        proposal: { conversationId, slide: transition.illustration.slide }
      }
    ]
  }
  return transition.illustrations.map((illustration) => ({
    prompt: illustration.prompt,
    proposal: { conversationId, slide: illustration.slide }
  }))
}

function transitionProposal(input: {
  service: ProposalDeckService
  conversationId: string
  transition: ProposalTransition
  content: string
}): { text: string; imageRequests?: ProposalDeferredImageRequest[] } {
  const { service, conversationId, transition, content } = input
  const next = service.transition(conversationId, transition, content)
  const imageRequests = imageRequestsFor(transition, conversationId)
  const buildInstruction =
    next.stage === 'complete'
      ? `\n\nNow call computer_task with this exact goal:\n${service.computerBuildGoal(next)}`
      : ''
  return {
    text: `${service.summary(next)}${buildInstruction}`,
    ...(imageRequests?.length ? { imageRequests } : {})
  }
}

export async function runProposalDeckTool(
  args: Record<string, unknown>,
  context: RunProposalDeckContext = {}
): Promise<{ text: string; imageRequests?: ProposalDeferredImageRequest[] }> {
  const { conversationId, userMessage = '', service = proposalDeckService() } = context
  if (!conversationId) return { text: 'Error: start this proposal inside a saved chat.' }
  const action = String(args.action ?? '')
  if (action === 'start') {
    try {
      return await startProposal(args, conversationId, service)
    } catch (error) {
      return { text: `Error: ${(error as Error).message}` }
    }
  }

  const current = service.get(conversationId)
  if (!current) return { text: 'Error: no proposal is active in this chat. Call start first.' }
  if (action === 'status') return { text: await service.context(current) }

  if (isApprovalAction(action) && !isExplicitProposalApproval(userMessage)) {
    return { text: 'Approval is not explicit. Show the current stage and wait for approval.' }
  }

  const transition = transitionFromArgs(args)
  if (!transition) return { text: `Error: unknown proposal action ${action}.` }

  try {
    return transitionProposal({
      service,
      conversationId,
      transition,
      content: String(args.content ?? '')
    })
  } catch (error) {
    return { text: `Error: ${(error as Error).message}` }
  }
}
