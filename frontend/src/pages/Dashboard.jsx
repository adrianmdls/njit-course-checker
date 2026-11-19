
import { useEffect, useRef, useState } from 'react'
import { Bookmark, Search, Trash2, Bell } from 'lucide-react'
import { useAuth } from '../auth'

import SearchCourses from '../components/SearchCourses'
import LastSeen from '../components/LastSeen'
import CourseAvailabilityInfo from '../components/CourseAvailabilityInfo'
import { termLabel } from '../utils/courseFormatting'

export default function Dashboard() {
  const { refresh } = useAuth()
  const [activeTab, setActiveTab] = useState('watchlist')
  const [courses, setCourses] = useState([])
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [pendingId, setPendingId] = useState(null)
  const mutation = useRef(false)
  const revision = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    const version = revision.current
    async function load() {
      setLoading(true)
      setError('')
      try {
        const response = await fetch('/api/watchlist', { credentials: 'same-origin', signal: controller.signal })
        if (controller.signal.aborted) return
        if (response.status === 401) { refresh(); return }
        if (!response.ok) throw new Error('Watchlist unavailable')
        const data = await response.json()
        if (!Array.isArray(data.sections)) throw new Error('Invalid watchlist response')
        if (controller.signal.aborted || version !== revision.current) return
        setCourses(data.sections)
        setLoaded(true)
      } catch {
        if (!controller.signal.aborted && version === revision.current) {
          setLoaded(false)
          setError('Unable to load your watchlist. Check your connection and retry.')
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    load()
    return () => controller.abort()
  }, [refresh, attempt, activeTab])

  async function changeWatchlist(section, remove = false) {
    const id = remove ? section.section_id : section.id
    if (mutation.current || loading || !loaded) return
    if (!remove && courses.some(course => course.section_id === id)) return
    mutation.current = true
    revision.current += 1
    setPendingId(id)
    setError('')
    try {
      const response = await fetch(remove ? `/api/watchlist/${id}` : '/api/watchlist', {
        method: remove ? 'DELETE' : 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'NJIT-Course-Checker' },
        body: JSON.stringify(remove ? {} : { section_id: id }),
      })
      if (response.status === 401) { refresh(); return }
      // Reconcile retries/cross-tab changes: a duplicate is already watched;
      // a missing entry on DELETE is already removed from this user's list.
      if (!response.ok && !(remove && response.status === 404) && !(!remove && response.status === 409)) {
        throw new Error(!remove && response.status === 404
          ? 'This section is no longer available. Search again.'
          : `Unable to ${remove ? 'remove' : 'add'} this section. Please retry.`)
      }
      revision.current += 1
      if (remove) setCourses(current => current.filter(course => course.section_id !== id))
      else setCourses(current => current.some(course => course.section_id === id)
        ? current : [...current, { ...section, section_id: id }])
    } catch (failure) {
      setError(failure instanceof TypeError ? 'Unable to update your watchlist. Check your connection and retry.'
        : failure.message || 'Unable to update your watchlist. Please retry.')
    } finally {
      mutation.current = false
      setPendingId(null)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1700px] px-3 py-6 sm:px-6 md:px-12 md:py-10">
      <div className="rounded-xl bg-white px-3 py-5 shadow-sm sm:px-5 md:px-8 md:py-6">

        
        {/* Dashboard tabs */}
        <div className="flex justify-center gap-3 border-b border-slate-200">
        {[
            { id: 'watchlist', label: 'Watchlist', Icon: Bookmark },
            { id: 'search', label: 'Search Courses', Icon: Search },
        ].map(({ id, label, Icon }) => (
            <div
            key={id}
            className={`min-w-0 flex-1 border-b-[3px] pb-2 sm:flex-none ${
                activeTab === id
                ? 'border-[#D60000]'
                : 'border-transparent'
            }`}
            >
            <button
                type="button"
                onClick={() => setActiveTab(id)}
                className={`flex min-h-[48px] w-full cursor-pointer items-center justify-center gap-2 rounded-md px-3 py-3 text-sm font-semibold transition-colors sm:min-h-[54px] sm:min-w-[275px] sm:gap-3 sm:px-6 sm:text-lg ${
                activeTab === id
                    ? 'bg-[#D60000] text-white'
                    : 'bg-slate-50 text-[#0B1733] hover:bg-slate-100'
                }`}
            >
                <Icon
                size={25}
                fill={
                    id === 'watchlist' && activeTab === id
                    ? 'currentColor'
                    : 'none'
                }
                />
                {label}
            </button>
            </div>
        ))}
        </div>


        {loading && <p role="status" className="mt-6 text-slate-500">Loading your watchlist…</p>}
        {error && <p role="alert" className="mt-6 text-red-600">{error}</p>}
        {!loading && !loaded && <button type="button" onClick={() => setAttempt(value => value + 1)} className="mt-3 rounded-md border border-slate-300 px-4 py-2 font-semibold">Retry watchlist</button>}

        {activeTab === 'watchlist' ? (
          <section className="mt-6" aria-labelledby="watchlist-heading">
            <div className="mb-4 flex items-center gap-1">
              <h2 id="watchlist-heading" className="text-xl font-bold">Watchlist ({courses.length})</h2>
              <CourseAvailabilityInfo />
            </div>
            <p id="notify-unavailable" className="sr-only">Email notifications are not yet available. This control is disabled.</p>
            <div className="overflow-x-auto rounded-md border border-slate-200">
              <table className="w-full min-w-[1280px] table-fixed border-collapse text-left text-[#0B1733]">
                <colgroup>
                  <col style={{ width: '8%' }} />
                  <col style={{ width: '13%' }} />
                  <col style={{ width: '13%' }} />
                  <col style={{ width: '9%' }} />
                  <col style={{ width: '9%' }} />
                  <col style={{ width: '9%' }} />
                  <col style={{ width: '10%' }} />
                  <col style={{ width: '14%' }} />
                  <col style={{ width: '9%' }} />
                  <col style={{ width: '6%' }} />
                </colgroup>
                <thead className="bg-slate-50">
                  <tr>
                    {['CRN', 'Course', 'Term', 'Section', 'Capacity', 'Enrolled', 'Status', 'Last Checked', 'Notify', 'Remove'].map((heading) => (
                      <th
                        key={heading}
                        className={`${heading === 'Remove' ? 'px-2' : 'px-3'} py-4 text-sm font-semibold whitespace-nowrap ${['Capacity', 'Enrolled'].includes(heading) ? 'text-right' : ['Status', 'Last Checked', 'Notify', 'Remove'].includes(heading) ? 'text-center' : 'text-left'}`}
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {courses.map((course) => {
                    const unavailable = course.is_active === false
                    const statusLabel = unavailable ? 'Unavailable'
                      : { OPEN: 'Open', CLOSED: 'Closed', CANCELLED: 'Cancelled' }[course.status] ?? 'Unknown'

                    return (
                      <tr key={course.section_id} className="border-t border-slate-200 hover:bg-slate-50">
                        <td className="px-3 py-3 text-left">{course.crn}</td>

                        <td className="px-3 py-3 text-left font-bold break-words">
                          <span title={course.title ?? undefined}>{course.course}</span>
                        </td>

                        <td className="px-3 py-3 text-left whitespace-nowrap">{termLabel(course.term)}</td>
                        <td className="px-3 py-3 text-left">{course.section ?? '—'}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{unavailable ? '—' : course.max ?? '—'}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{unavailable ? '—' : course.now ?? '—'}</td>

                        <td className="px-3 py-3 text-center">
                          <span
                            className={`inline-block min-w-[88px] rounded-md px-3 py-1.5 text-center text-sm font-semibold ${
                              unavailable ? 'bg-slate-100 text-slate-600' : course.status === 'OPEN'
                                ? 'bg-green-100 text-green-700'
                                : course.status === 'CLOSED' ? 'bg-red-100 text-red-600' : 'bg-slate-100 text-slate-600'
                            }`}
                          >
                            {statusLabel}
                          </span>
                          {unavailable && <p className="mt-1 text-xs text-slate-500">Previously marked unavailable; awaiting a new Banner observation.</p>}
                        </td>

                        <td className="px-3 py-3 text-center">
                          <LastSeen timestamp={course.last_checked_at} />
                        </td>

                        <td className="px-3 py-3 text-center">
                          <span tabIndex={0} role="group" aria-label="Email notifications coming soon"
                            aria-describedby="notify-unavailable" title="Email notifications are not yet available."
                            className="inline-flex rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700">
                            <button type="button" disabled aria-label="Email notifications coming soon"
                              aria-describedby="notify-unavailable"
                              className="pointer-events-none flex size-10 cursor-not-allowed items-center justify-center rounded-md bg-slate-100 text-slate-400">
                              <Bell size={18} aria-hidden="true" />
                            </button>
                          </span>
                        </td>

                        <td className="px-2 py-3 text-center">
                          <button
                            type="button"
                            onClick={() => changeWatchlist(course, true)}
                            disabled={loading || !loaded || pendingId !== null}
                            aria-label={`Remove ${course.course} section ${course.section ?? "unknown"} (${course.term}) from watchlist`}
                            title={`Remove ${course.course} section ${course.section ?? "unknown"} from watchlist`}
                            className="mx-auto flex min-h-10 cursor-pointer items-center justify-center rounded-md bg-red-50 px-3 py-2 text-red-700 hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {pendingId === course.section_id ? 'Removing…' : <Trash2 size={18} />}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              {loaded && !loading && courses.length === 0 && (
                <p className="p-8 text-center text-slate-500">
                  Your watchlist is empty.
                </p>
              )}
            </div>
          </section>
        ) : (
            <SearchCourses courses={courses} onAdd={changeWatchlist} watchlistReady={loaded && !loading} pendingId={pendingId} />
        )}
      </div>
    </div>
  )
}
