// The renderer CSP (style-src 'self' 'nonce-…') blocks every <style> without the page nonce.
// Three libraries write such tags at runtime:
// - media-chrome (the audio and video players) writes each control's shadow DOM from an HTML
//   string, so its controls drew unstyled, with both labels of every toggle showing;
// - Motion's AnimatePresence popLayout pins an exiting screen with a <style>, so a screen
//   change jumped instead of gliding. Motion reads the nonce from MotionConfig.
// - CodeMirror (the file viewer's text pane) writes its base theme into one <style> per document,
//   so a text or Markdown file drew its line numbers above the text instead of beside it.

import { EditorView } from '@offgrid/operator-ui/operator/media/code-editor'

/** The page's CSP nonce, published by Vite's html.cspNonce meta tag. */
export function cspNonce(): string | undefined {
  return document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce || undefined
}

function stamp(html: string, nonce: string): string {
  return html.replace(/<style(?=[\s>])/gi, `<style nonce="${nonce}"`)
}

/**
 * CodeMirror's styles share ONE <style> per document, and that tag carries the nonce of the first
 * editor to mount. The library's editors pass none, so a nonce-carrying editor mounts first.
 */
function stampEditorStyles(nonce: string): void {
  new EditorView({
    extensions: EditorView.cspNonce.of(nonce),
    parent: document.createElement('div')
  }).destroy()
}

/** Stamp the nonce on styles written into shadow roots, and on CodeMirror's document styles. */
export function initShadowStyleNonce(): void {
  const nonce = cspNonce()
  if (!nonce) return
  stampEditorStyles(nonce)
  const proto = ShadowRoot.prototype
  const setHTMLUnsafe = proto.setHTMLUnsafe
  proto.setHTMLUnsafe = function (html) {
    setHTMLUnsafe.call(this, stamp(String(html), nonce))
  }
  const innerHTML = Object.getOwnPropertyDescriptor(proto, 'innerHTML')
  const setInnerHTML = innerHTML?.set
  if (innerHTML && setInnerHTML) {
    Object.defineProperty(proto, 'innerHTML', {
      ...innerHTML,
      set(html: string) {
        setInnerHTML.call(this, stamp(String(html), nonce))
      }
    })
  }
}
