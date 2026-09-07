/**
 * Pull the JSON object out of a model reply.
 *
 * A reasoning model emits a `<think>…</think>` block (and sometimes stray prose)
 * before the JSON, which a raw `JSON.parse` rejects - the rail then reads it as
 * "did not parse" and loops. Strip anything up to the last `</think>`, then take
 * the outermost `{ … }`. Returns that slice, or null when there is no object.
 *
 * Shared by every rail that asks a general chat model for a JSON step (the AX
 * rail and the web rail), so the fix lives in one place.
 */
export function extractJsonObject(raw: string): string | null {
  let text = raw
  const thinkClose = text.lastIndexOf('</think>')
  if (thinkClose !== -1) {
    text = text.slice(thinkClose + '</think>'.length)
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    return null
  }
  return text.slice(start, end + 1)
}
