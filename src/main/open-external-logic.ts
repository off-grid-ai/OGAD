/**
 * The allow-list for `app:open-external`. Pure so the security decision - which
 * schemes may reach the OS opener - is tested without Electron. Only https (web
 * links) and mailto (the workflow-request CTA); never file:, never a raw shell
 * target, so a crafted string can't be turned into an arbitrary OS open.
 */
export function isAllowedExternalUrl(url: string): boolean {
  return /^(https:\/\/|mailto:)/i.test(url)
}
