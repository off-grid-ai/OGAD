import type { WebContents } from 'electron'
import contextMenu from 'electron-context-menu'

export interface PageMenuActions {
  openInNewTab(url: string): void
  download(url: string): void
}

/**
 * The page's right-click menu, from electron-context-menu (MIT): copy, paste, look up, search,
 * copy link and image, inspect. Opening and saving go through the browser's own tabs and
 * download list.
 */
export function attachPageMenu(contents: WebContents, actions: PageMenuActions): () => void {
  return contextMenu({
    window: contents,
    showInspectElement: true,
    showSaveImage: false,
    showSaveImageAs: false,
    showSaveLinkAs: false,
    showCopyImage: true,
    showCopyLink: true,
    showSelectAll: true,
    showServices: false,
    prepend: (_defaults, params) => [
      {
        label: 'Open Link in New Tab',
        visible: /^https?:\/\//i.test(params.linkURL),
        click: () => actions.openInNewTab(params.linkURL)
      },
      {
        label: 'Save Link',
        visible: /^https?:\/\//i.test(params.linkURL),
        click: () => actions.download(params.linkURL)
      },
      {
        label: 'Open Image in New Tab',
        visible: params.mediaType === 'image' && /^https?:\/\//i.test(params.srcURL),
        click: () => actions.openInNewTab(params.srcURL)
      },
      {
        label: 'Save Image',
        visible: params.mediaType === 'image' && /^(https?|data|blob):/i.test(params.srcURL),
        click: () => actions.download(params.srcURL)
      },
      {
        label: 'Back',
        visible: !params.linkURL && !params.srcURL && !params.isEditable && !params.selectionText,
        enabled: contents.navigationHistory.canGoBack(),
        click: () => contents.navigationHistory.goBack()
      },
      {
        label: 'Forward',
        visible: !params.linkURL && !params.srcURL && !params.isEditable && !params.selectionText,
        enabled: contents.navigationHistory.canGoForward(),
        click: () => contents.navigationHistory.goForward()
      },
      {
        label: 'Reload',
        visible: !params.linkURL && !params.srcURL && !params.isEditable && !params.selectionText,
        click: () => contents.reload()
      }
    ]
  })
}
