/**
 * Desktop binding of the semantic Web Use decision: the model call. The prompt, the JSON schema,
 * the validation of the untrusted reply, and the completion-evidence rule are
 * `@offgrid/automation`'s (`web-use-semantic-decision`).
 */
import {
  parseSemanticDecision,
  WEB_USE_SEMANTIC_STEP_FORMAT,
  webUseSemanticDecisionPrompt,
  type SemanticDecision,
  type WebUseSemanticDecisionRequest
} from '@offgrid/automation'
import { extractJsonObject } from '../json-extract'

export {
  completionEvidenceMatches,
  parseSemanticDecision,
  type SemanticDecision
} from '@offgrid/automation'
export type BrowserSemanticDecisionRequest = WebUseSemanticDecisionRequest

/** One small-model decision over one untrusted Playwright snapshot. */
export async function decideBrowserSemanticAction(
  request: BrowserSemanticDecisionRequest
): Promise<SemanticDecision> {
  const { llm } = await import('../llm')
  const { desktopModels, generateWithDesktopModels } = await import(
    '../composition/application-access'
  )
  const prompt = webUseSemanticDecisionPrompt(request)
  await desktopModels.refresh()
  const systemPrompt = llm.getSettings().systemPrompt?.trim()
  const result = await generateWithDesktopModels({
    operation: { type: 'text' },
    messages: [
      ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
      { role: 'user', content: prompt }
    ],
    profile: 'structured-step',
    responseFormat: {
      type: 'json_schema',
      name: WEB_USE_SEMANTIC_STEP_FORMAT.json_schema.name,
      schema: WEB_USE_SEMANTIC_STEP_FORMAT.json_schema.schema,
      strict: WEB_USE_SEMANTIC_STEP_FORMAT.json_schema.strict
    },
    signal: request.signal
  })
  const json = extractJsonObject(result.content)
  if (!json) throw new Error('The text model returned no Web Use action.')
  return parseSemanticDecision(JSON.parse(json) as unknown, request.snapshot)
}
