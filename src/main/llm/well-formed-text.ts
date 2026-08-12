// Guarantee that every string we put on the wire can survive JSON serialisation.
//
// Why this exists: macOS Accessibility hands us UTF-16. A read that lands in the middle of a
// surrogate pair (an emoji, a CJK extension character) yields a LONE surrogate. JSON.stringify
// happily emits that as `\ud83d`, which is valid ECMAScript but NOT valid JSON text — nlohmann,
// the parser inside llama-server, rejects the whole body with
// `parse error … invalid string: surrogate U+D800..U+DBFF must be followed by U+DC00..U+DF`.
//
// The server then 500s on every retry, forever, because the input never changes. One capture
// frame on a real machine burned 32 attempts this way.
//
// Sanitising at each producing field would be a losing game: any string reaching the payload can
// carry one. Only the layer that builds the request can guarantee the request is well formed, so
// the repair belongs here and runs once.

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

interface WellFormedCapable {
  toWellFormed?: () => string
}

/** Replace every unpaired surrogate with U+FFFD. Well-formed input is returned unchanged. */
export function toWellFormedText(value: string): string {
  const native = (value as unknown as WellFormedCapable).toWellFormed
  if (typeof native === 'function') return native.call(value)
  return value.replace(LONE_SURROGATE, '�')
}
