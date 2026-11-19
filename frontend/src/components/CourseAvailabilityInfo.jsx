import { Info } from 'lucide-react'

export default function CourseAvailabilityInfo() {
  return <div className="mb-4 flex items-start gap-2 text-sm leading-6 text-slate-600">
    <Info size={16} aria-hidden="true" className="mt-1 shrink-0" />
    <div>
      <p className="font-semibold">About Course Availability</p>
      <p>To reduce requests to NJIT Banner, departments with watchlisted courses are checked approximately every 10 minutes. Other departments are checked less frequently.</p>
      <p><strong>Last Seen</strong> shows when each section was last observed in NJIT Banner.</p>
      <p className="mt-1">Availability may have changed since Last Seen. Sections omitted from a check retain their previous observation time.</p>
    </div>
  </div>
}
