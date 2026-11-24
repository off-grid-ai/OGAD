/**
 * A generated page that throws, or loads a script that is not there, drew nothing: the canvas
 * showed a blank frame with no reason. The page now shows each error over itself, as React
 * artifacts already do. Resource errors (a 404 script) only reach a capturing listener.
 */
const HTML_ERROR_OVERLAY = `<script>(function(){var box=null,seen={};function show(msg){msg=String(msg);if(seen[msg])return;seen[msg]=1;if(!document.body){document.addEventListener('DOMContentLoaded',function(){seen[msg]=0;show(msg)});return}if(!box){box=document.createElement('pre');box.setAttribute('data-og-artifact-error','');box.style.cssText='position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;margin:0;max-height:40%;overflow:auto;padding:10px 12px;border-radius:8px;background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap';document.body.appendChild(box)}box.textContent+=(box.textContent?'\\n':'')+msg;try{parent.postMessage({__ogArtifactError:msg},'*')}catch(e){}}window.addEventListener('error',function(e){var t=e.target;if(t&&t!==window&&(t.src||t.href)){show('Could not load '+(t.src||t.href));return}show(e.error&&e.error.stack||e.message)},true);window.addEventListener('unhandledrejection',function(e){show(e.reason&&e.reason.stack||e.reason)})})();</script>`

/** Puts the error overlay first in the page, before any script of its own can fail. */
export function withHtmlErrorOverlay(html: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html)
  if (head) return html.replace(head[0], head[0] + HTML_ERROR_OVERLAY)
  const root = /<html(\s[^>]*)?>/i.exec(html)
  if (root) return html.replace(root[0], root[0] + HTML_ERROR_OVERLAY)
  return HTML_ERROR_OVERLAY + html
}
