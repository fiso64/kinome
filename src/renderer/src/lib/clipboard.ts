/**
 * Copy text during the user's click. Browsers expose the Clipboard API only
 * to secure origins, which excludes a server reached over plain HTTP on a LAN.
 */
export function copyTextDuringClick(text: string): void {
  const focused = document.activeElement
  const field = document.createElement('textarea')
  field.value = text
  field.readOnly = true
  field.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
  // Content outside an open modal dialog is inert and cannot hold a selection.
  const host = Array.from(document.querySelectorAll('dialog:modal')).at(-1) ?? document.body
  host.append(field)
  field.select()
  const copied = document.execCommand('copy')
  field.remove()
  if (focused instanceof HTMLElement) focused.focus({ preventScroll: true })
  if (!copied) throw new Error('The browser refused to copy to the clipboard.')
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
  else copyTextDuringClick(text)
}
