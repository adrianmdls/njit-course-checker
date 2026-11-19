import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { observationTime } from '../utils/courseFormatting'
import { positionFloating } from '../utils/positionFloating'

const badgeClass = 'inline-flex min-h-8 w-[124px] shrink-0 items-center justify-center rounded-md bg-slate-100 px-3 py-1.5 text-center text-sm leading-5 font-medium whitespace-normal text-slate-600'

export default function LastSeen({ timestamp }) {
  const observation = observationTime(timestamp)
  const id = useId()
  const trigger = useRef(null)
  const panel = useRef(null)
  const timer = useRef(null)
  const focused = useRef(false)
  const [open, setOpen] = useState(false)
  function position() { positionFloating(trigger.current, panel.current) }
  function show() {
    clearTimeout(timer.current)
    panel.current.showPopover()
    position()
  }
  function leave() {
    if (!focused.current) timer.current = setTimeout(() => panel.current?.hidePopover(), 150)
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

  return <div className="mx-auto min-w-32 max-w-60 text-center text-sm text-slate-600">
    {observation.dateTime ? <Fragment>
      <time ref={trigger} dateTime={observation.dateTime} tabIndex={0}
        aria-label={`${observation.label}; ${observation.exact}`} aria-controls={id}
        onPointerEnter={event => { if (event.pointerType === 'mouse') show() }} onPointerLeave={leave}
        onFocus={() => { focused.current = true; show() }}
        onBlur={() => { focused.current = false; leave() }}
        className={`${badgeClass} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700`}>
        <span className="min-w-0 break-words">{observation.label}</span>
      </time>
      <span ref={panel} id={id} role="tooltip" aria-hidden="true" popover="auto"
        onToggle={event => setOpen((event.newState ?? event.nativeEvent?.newState) === 'open')}
        onPointerEnter={() => clearTimeout(timer.current)} onPointerLeave={leave}
        className="fixed right-auto bottom-auto m-0 max-w-[calc(100vw-24px)] rounded-md border border-slate-200 bg-white px-3 py-2 text-xs leading-4 font-normal text-slate-700 shadow-sm">
        {observation.exact}
      </span>
    </Fragment> : <span className={badgeClass}><span className="min-w-0 break-words">{observation.label}</span></span>}
    {observation.note && <p className="mt-1 text-xs">{observation.note}</p>}
  </div>
}
