/** @deprecated Portable OpenAI stream policy lives in @offgrid/models. */
export {
  createInlineThinkSplitter as createThinkSplitter,
  createOpenAIToolCallAccumulator as createToolCallAccumulator,
  createOpenAIToolMarkupFilter as createToolMarkupFilter,
  displayableOpenAIReasoningDelta as displayableReasoningDelta,
  parseOpenAISseLine as parseSseLine
} from '@offgrid/models'
export type {
  AssembledOpenAIToolCall as AssembledToolCall,
  OpenAISseDelta as SseDelta,
  OpenAISseFrame as SseFrame,
  OpenAISseTimings as SseTimings,
  OpenAISseToolCallDelta as SseToolCallDelta,
  OpenAISseUsage as SseUsage,
  ReasoningStreamEvent as StreamEvent
} from '@offgrid/models'
