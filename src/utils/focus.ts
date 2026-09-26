const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function focusFirst(root: HTMLElement | null | undefined) {
  root?.querySelector<HTMLElement>(focusableSelector)?.focus()
}

export function trapFocus(event: KeyboardEvent, root: HTMLElement | null | undefined) {
  if (event.key !== 'Tab' || !root) return
  const items = [...root.querySelectorAll<HTMLElement>(focusableSelector)].filter(
    (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
  )
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
