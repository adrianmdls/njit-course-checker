// Fixed, top-layer panels stay independent of table layout and scrolling.
export function positionFloating(trigger, panel, viewport = window) {
  const anchor = trigger.getBoundingClientRect()
  const { width, height } = panel.getBoundingClientRect()
  const left = Math.max(12, Math.min(anchor.left, viewport.innerWidth - width - 12))
  const below = anchor.bottom + 6
  const preferredTop = below + height <= viewport.innerHeight - 12 ? below : anchor.top - height - 6
  const top = Math.max(12, Math.min(preferredTop, viewport.innerHeight - height - 12))
  panel.style.left = `${left}px`
  panel.style.top = `${top}px`
}
