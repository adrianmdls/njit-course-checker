import { observationTime } from '../utils/courseFormatting'

export default function LastSeen({ timestamp }) {
  const observation = observationTime(timestamp)
  return <div className="min-w-36 max-w-60 text-sm text-slate-600">
    {observation.dateTime ? <time dateTime={observation.dateTime} title={observation.exact} tabIndex={0}
      className="group block rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700">
      <span>{observation.label}</span>
      <span className="sr-only"> — {observation.exact}</span>
      <span aria-hidden="true" className="hidden whitespace-normal text-xs group-hover:block group-focus:block">{observation.exact}</span>
    </time> : <span>{observation.label}</span>}
    {observation.note && <p className="mt-1 text-xs">{observation.note}</p>}
  </div>
}
