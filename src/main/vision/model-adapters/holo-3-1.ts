import {
  buildCanonicalVisionOperatorRequest,
  generalVisionPolicyFailure
} from './general-vision-operator'
import { parseGeneralVisionToolResponse } from './general-vision-tools'
import type { VisionModelAdapter, VisionPolicyResponse, VisionPolicyToolCall } from './types'

function jsonValue(value: string): unknown {
  const text = value.trim()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Parse Holo 3.1's official Qwen XML function-call form when the server does not project it. */
export function parseHoloToolCall(content: string): VisionPolicyToolCall | null {
  const calls = [...content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)]
  if (calls.length !== 1) return null
  const body = calls[0]?.[1] ?? ''
  const fn = body.match(/^\s*<function=([^>\s]+)>\s*([\s\S]*?)\s*<\/function>\s*$/i)
  if (!fn?.[1] || fn[2] === undefined) return null
  const args: Record<string, unknown> = {}
  const parameterPattern = /<parameter=([^>\s]+)>\s*([\s\S]*?)\s*<\/parameter>/gi
  const parameters = [...fn[2].matchAll(parameterPattern)]
  const residue = fn[2].replace(parameterPattern, '').trim()
  if (residue || parameters.some((parameter) => !parameter[1] || parameter[2] === undefined)) {
    return null
  }
  for (const parameter of parameters) {
    const name = parameter[1]!
    if (Object.hasOwn(args, name)) return null
    args[name] = jsonValue(parameter[2]!)
  }
  return { id: 'holo-3.1-call', name: fn[1], arguments: JSON.stringify(args) }
}

function normalizedHoloResponse(response: VisionPolicyResponse): VisionPolicyResponse {
  if (response.toolCalls.length > 0) return response
  const call = parseHoloToolCall(response.content)
  return call ? { content: response.content, toolCalls: [call] } : response
}

export const holo31Adapter: VisionModelAdapter = {
  id: 'holo-3.1',
  requiresLoadCapabilityGate: true,
  matches(model) {
    return /holo[-_ ]?3\.1/i.test(`${model.id} ${model.primaryFile}`)
  },
  assertCapabilities(model) {
    if (!model.projectorFile || !model.availableFiles.includes(model.projectorFile)) {
      throw new Error('The selected Holo 3.1 model has no installed vision projector.')
    }
  },
  buildRequest(input) {
    const request = buildCanonicalVisionOperatorRequest(input)
    const encoded = input.coordinateFrame?.encoded
    return {
      ...request,
      validateResponse: (response) =>
        encoded ? holo31PolicyFailure(response, encoded) === undefined : false,
      responseValidationError: (response) =>
        encoded ? holo31PolicyFailure(response, encoded) : 'screenshot bounds were missing'
    }
  },
  parseResponse(content, bounds) {
    return parseGeneralVisionToolResponse(
      normalizedHoloResponse({ content, toolCalls: [] }),
      bounds
    )
  },
  parsePolicyResponse(response, bounds) {
    return parseGeneralVisionToolResponse(normalizedHoloResponse(response), bounds)
  }
}

export function holo31PolicyFailure(
  response: VisionPolicyResponse,
  bounds: Parameters<typeof generalVisionPolicyFailure>[1]
): string | undefined {
  return generalVisionPolicyFailure(normalizedHoloResponse(response), bounds)
}
