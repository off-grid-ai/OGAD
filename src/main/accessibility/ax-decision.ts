import type { OptionDecision } from '../llm'
import type { AxSnapshot } from './ax-elements'
import type { ElementStep } from './ax-agent'

const MAX_OPTIONS = 10

interface DecisionCandidate {
  description: string
  step: ElementStep
}

export type ScoreOptions = (
  context: string,
  question: string,
  options: readonly string[]
) => Promise<OptionDecision>

export function elementDecisionCandidates(snapshot: AxSnapshot): DecisionCandidate[] {
  const elements = snapshot.elements.slice(0, 120).filter((element) => element.enabled)
  return [
    ...elements.map((element) => ({
      description: `${element.actionable ? 'Activate' : 'Click'} control [${element.index}] ${element.role} ${JSON.stringify(element.name || element.value || 'unnamed')}`,
      step: element.actionable
        ? ({ action: 'press', index: element.index } as const)
        : ({ action: 'click', index: element.index } as const)
    })),
    {
      description: 'Press Enter to submit the current focused value',
      step: { action: 'key', keys: 'Enter' }
    },
    {
      description: 'The task is visibly complete',
      step: { action: 'done', summary: 'The requested change is visible.' }
    },
    {
      description: 'The next step needs private user input',
      step: { action: 'human_required', why: 'Private input is required.' }
    },
    {
      description: 'Use the visual specialist because text entry or a visual target is required',
      step: { action: 'vision_required', why: 'The next step needs the visual specialist.' }
    }
  ]
}

function groupDescription(candidates: readonly DecisionCandidate[]): string {
  return `Choose from this action group: ${candidates.map((candidate) => candidate.description).join('; ')}`
}

/** Keep every model call within the model's trained A-J option head. Large AX
 * trees are narrowed through bounded groups, then scored again inside the
 * selected group. */
export async function chooseElementStep(
  context: string,
  snapshot: AxSnapshot,
  score: ScoreOptions
): Promise<{ step: ElementStep; confidence: number }> {
  let candidates = elementDecisionCandidates(snapshot)
  while (candidates.length > MAX_OPTIONS) {
    const groupSize = Math.ceil(candidates.length / MAX_OPTIONS)
    const groups: DecisionCandidate[][] = []
    for (let index = 0; index < candidates.length; index += groupSize) {
      groups.push(candidates.slice(index, index + groupSize))
    }
    const decision = await score(
      context,
      'Which action group contains the best next action?',
      groups.map(groupDescription)
    )
    candidates = groups[decision.choice] ?? []
  }
  if (candidates.length < 2) {
    return {
      step: candidates[0]?.step ?? {
        action: 'vision_required',
        why: 'No safe accessibility action is available.'
      },
      confidence: 1
    }
  }
  const decision = await score(
    context,
    'Which single action best advances the task from the current state?',
    candidates.map((candidate) => candidate.description)
  )
  return { step: candidates[decision.choice]!.step, confidence: decision.confidence }
}

export function serializeElementStep(step: ElementStep): string {
  return JSON.stringify(step)
}
