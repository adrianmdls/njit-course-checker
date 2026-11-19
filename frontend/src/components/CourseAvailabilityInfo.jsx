import { useEffect, useId, useRef, useState } from 'react'
import { Info } from 'lucide-react'
import { positionFloating } from '../utils/positionFloating'

export default function CourseAvailabilityInfo() {
  const id = useId()
  const trigger = useRef(null)
  const panel = useRef(null)
  const timer = useRef(null)
  const pinned = useRef(false)
  const [open, setOpen] = useState(false)

  function position() { positionFloating(trigger.current, panel.current) }
  function show() {
    clearTimeout(timer.current)
    panel.current.showPopover()
    position()
  }
  function leave(event) {
    if (event.pointerType !== 'mouse' || pinned.current) return
    timer.current = setTimeout(() => panel.current?.hidePopover(), 150)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (!open) return
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open])

  return <div className="inline-flex shrink-0 items-center">
    <button ref={trigger} type="button" aria-label="About Course Availability"
      aria-expanded={open} aria-controls={id} popoverTarget={id}
      onPointerEnter={event => { if (event.pointerType === 'mouse') show() }} onPointerLeave={leave}
      onClick={event => {
        event.preventDefault()
        clearTimeout(timer.current)
        if (pinned.current && panel.current.matches(':popover-open')) { panel.current.hidePopover(); pinned.current = false }
        else { show(); pinned.current = true }
      }}
      className="flex size-8 cursor-pointer items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700">
      <Info size={16} aria-hidden="true" />
    </button>
    <div ref={panel} id={id} popover="auto" role="region" aria-label="About Course Availability"
      onToggle={event => {
        const expanded = (event.newState ?? event.nativeEvent?.newState) === 'open'
        setOpen(expanded)
        if (!expanded) { pinned.current = false; clearTimeout(timer.current) }
      }}
      onPointerEnter={() => clearTimeout(timer.current)} onPointerLeave={leave}
      className="fixed right-auto bottom-auto m-0 max-h-[calc(100dvh-24px)] w-80 max-w-[calc(100vw-24px)] overflow-y-auto rounded-md border border-slate-200 bg-white p-3 text-left text-xs leading-5 font-normal text-slate-600 shadow-sm">
      <p className="mb-1 text-xs font-semibold text-slate-900">About Course Availability</p>
      <p>Departments with watchlisted courses are checked about every 10 minutes. Other departments are checked less frequently to reduce requests to NJIT Banner.</p>
      <p className="mt-2"><strong>Last Checked</strong> shows when each section was last observed in NJIT Banner. Availability may have changed since then.</p>
    </div>
  </div>
}
