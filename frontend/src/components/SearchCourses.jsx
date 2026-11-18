
import { useEffect, useRef, useState } from 'react'
import { Search, BookmarkPlus, Check } from 'lucide-react'
import { useAuth } from '../auth'

function termLabel(code) {
  const year = Number(code.slice(0, 4))
  const season = { '10': 'Spring', '50': 'Summer', '90': 'Fall', '95': 'Winter' }[code.slice(4)]
  return season ? `${season} ${year}${code.endsWith('95') ? `–${year + 1}` : ''}` : code
}

export default function SearchCourses({ courses, onAdd, watchlistReady, pendingId }) {
  const { refresh } = useAuth()
  const [term, setTerm] = useState('')
  const [options, setOptions] = useState(null)
  const [optionsError, setOptionsError] = useState('')
  const [optionsAttempt, setOptionsAttempt] = useState(0)
  const [department, setDepartment] = useState('')
  const [courseNumber, setCourseNumber] = useState('')
  const [status, setStatus] = useState('')
  const [sort, setSort] = useState('course')
  const [order, setOrder] = useState('asc')
  const [results, setResults] = useState(null)
  const [pagination, setPagination] = useState({ limit: 50, offset: 0, total: 0 })
  const [submittedFilters, setSubmittedFilters] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const activeRequest = useRef(null)
  const departments = options?.terms.find(entry => entry.code === term)?.departments ?? []

  useEffect(() => {
    const controller = new AbortController()
    async function loadOptions() {
      try {
        const response = await fetch('/api/courses/options', {
          credentials: 'same-origin', signal: controller.signal,
        })
        if (controller.signal.aborted) return
        if (response.status === 401) { refresh(); return }
        if (!response.ok) throw new Error('Catalog unavailable')
        const data = await response.json()
        if (controller.signal.aborted) return
        setOptions(data)
        setTerm(current => data.terms.some(entry => entry.code === current) ? current : data.terms[0]?.code ?? '')
      } catch {
        if (!controller.signal.aborted) setOptionsError('Unable to load available terms and departments. Please retry.')
      }
    }
    loadOptions()
    return () => controller.abort()
  }, [refresh, optionsAttempt])

  useEffect(() => () => activeRequest.current?.abort(), [])

  async function search(filters, offset) {
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setLoading(true)
    setError('')
    setResults(null)

    try {
      const params = new URLSearchParams({ ...filters, limit: '50', offset: String(offset) })
      const response = await fetch(`/api/courses?${params}`, {
        credentials: 'same-origin', signal: controller.signal,
      })
      if (controller.signal.aborted || activeRequest.current !== controller) return
      if (response.status === 401) {
        // Recheck the session through the existing provider and route guard.
        refresh()
        return
      }
      if (!response.ok) {
        setError(response.status === 400
          ? 'Check your search filters. Use a course number or code such as CS 280, with a matching department.'
          : 'Course search is temporarily unavailable. Please try again.')
        return
      }
      const data = await response.json()
      if (controller.signal.aborted || activeRequest.current !== controller) return
      setResults(data.sections)
      setPagination(data.pagination)
    } catch {
      if (!controller.signal.aborted && activeRequest.current === controller) {
        setError('Unable to load courses. Check your connection and try again.')
      }
    } finally {
      if (!controller.signal.aborted && activeRequest.current === controller) setLoading(false)
    }
  }

  function handleSearch(event) {
    event.preventDefault()
    if (!options || !term) return
    const filters = { term, sort, order }
    if (department) filters.subject = department
    if (courseNumber.trim()) filters.query = courseNumber.trim().replace(/\s+/g, ' ').toUpperCase()
    if (status) filters.status = status
    setSubmittedFilters(filters)
    search(filters, 0)
  }

  return (
    <section className="mt-6">
      <form
        onSubmit={handleSearch}
        className="grid grid-cols-1 gap-5 rounded-lg bg-slate-50 p-6 md:grid-cols-3"
      >
        <div>
          <label htmlFor="search-term" className="mb-2 block font-semibold">
            Term
          </label>
          <select
            id="search-term"
            value={term}
            disabled={!options?.terms.length}
            onChange={(event) => {
              const code = event.target.value
              if (code === term) return
              activeRequest.current?.abort()
              activeRequest.current = null
              setTerm(code)
              setResults(null)
              setSubmittedFilters(null)
              setPagination({ limit: 50, offset: 0, total: 0 })
              setLoading(false)
              setError('')
            }}
            className="w-full rounded-md border border-slate-300 bg-white px-4 py-3"
          >
            {!options?.terms.length && <option value="">{options ? 'No local terms available' : 'Loading terms…'}</option>}
            {options?.terms.map(entry => <option key={entry.code} value={entry.code}>{termLabel(entry.code)}</option>)}
          </select>
        </div>

        <div>
          <label htmlFor="search-department" className="mb-2 block font-semibold">
            Department
          </label>
          <select
            id="search-department"
            value={department}
            disabled={!term}
            onChange={(event) => setDepartment(event.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-4 py-3"
          >
            <option value="">All Departments</option>
            {department && !departments.includes(department) && <option value={department}>{department}</option>}
            {departments.map((subject) => (
              <option key={subject} value={subject}>
                {subject}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="search-number" className="mb-2 block font-semibold">
            Course Number or Code
          </label>
          <input
            id="search-number"
            type="text"
            maxLength={100}
            value={courseNumber}
            onChange={(event) => setCourseNumber(event.target.value)}
            placeholder="e.g., 280 or CS 280"
            className="w-full rounded-md border border-slate-300 bg-white px-4 py-3"
          />
        </div>

        <div>
          <label htmlFor="search-status" className="mb-2 block font-semibold">Status</label>
          <select
            id="search-status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-4 py-3"
          >
            <option value="">All Statuses</option>
            <option value="OPEN">Open</option>
            <option value="CLOSED">Closed</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>

        <div>
          <label htmlFor="search-sort" className="mb-2 block font-semibold">Sort By</label>
          <select
            id="search-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-4 py-3"
          >
            <option value="course">Course</option>
            <option value="crn">CRN</option>
            <option value="availability">Availability</option>
          </select>
        </div>

        <div>
          <label htmlFor="search-order" className="mb-2 block font-semibold">Order</label>
          <select
            id="search-order"
            value={order}
            onChange={(event) => setOrder(event.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-4 py-3"
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </div>

        <button
          type="submit"
          disabled={loading || !options || !term}
          className="flex cursor-pointer items-center justify-center gap-2 rounded-md bg-[#D60000] px-6 py-3 font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60 md:col-span-3"
        >
          <Search size={20} />
          {loading ? 'Searching…' : 'Search Courses'}
        </button>
      </form>

      {!options && !optionsError && <p role="status" className="mt-6 text-slate-500">Loading available terms and departments…</p>}
      {optionsError && (
        <div className="mt-6">
          <p role="alert" className="text-red-600">{optionsError}</p>
          <button type="button" onClick={() => { setOptionsError(''); setOptionsAttempt(attempt => attempt + 1) }} className="mt-2 cursor-pointer rounded-md border border-slate-300 px-4 py-2 font-semibold">Retry catalog options</button>
        </div>
      )}
      {options?.terms.length === 0 && <p role="status" className="mt-6 text-slate-500">No searchable local catalog data is available. Selected departments and terms must be synchronized before searching.</p>}
      {loading && <p role="status" className="mt-6 text-slate-500">Loading course sections…</p>}
      {error && <p role="alert" className="mt-6 text-red-600">{error}</p>}
      {options?.terms.length > 0 && results === null && !loading && !error && (
        <p className="mt-6 text-slate-500">Choose your filters and search for course sections.</p>
      )}

      {results !== null && (
        <div className="mt-8">
          <h2 className="mb-4 text-xl font-bold">
            Search Results ({pagination.total})
          </h2>

          <div className="overflow-x-auto rounded-md border border-slate-200">
            <table className="w-full min-w-[750px] text-left">
              <thead className="bg-slate-50">
                <tr>
                  {['CRN', 'Course', 'Section', 'Max', 'Now', 'Status', 'Watchlist'].map((heading) => (
                    <th key={heading} className="px-5 py-4 font-semibold">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {results.map((section) => {
                  const statusLabel = section.status === 'OPEN' ? 'Open'
                    : section.status === 'CLOSED' ? 'Closed'
                      : section.status === 'CANCELLED' ? 'Cancelled' : 'Unknown'
                  const isWatched = courses.some(
                    (course) => course.section_id === section.id
                  )

                  return (
                    <tr key={section.id} className="border-t border-slate-200">
                      <td className="px-5 py-3">{section.crn}</td>
                      <td className="px-5 py-3 font-bold">{section.course}</td>
                      <td className="px-5 py-3">{section.section ?? '—'}</td>
                      <td className="px-5 py-3">{section.max ?? '—'}</td>
                      <td className="px-5 py-3">{section.now ?? '—'}</td>

                      <td className="px-5 py-3">
                        <span className={`inline-block min-w-[85px] rounded-md px-3 py-2 text-center font-semibold ${
                          section.status === 'OPEN'
                            ? 'bg-green-100 text-green-700'
                            : section.status === 'CLOSED'
                              ? 'bg-red-100 text-red-600'
                              : 'bg-slate-100 text-slate-600'
                        }`}>
                          {statusLabel}
                        </span>
                      </td>

                      <td className="px-5 py-3">
                        <button
                          type="button"
                          disabled={isWatched || !watchlistReady || pendingId !== null}
                          onClick={() => onAdd(section)}
                          className={`flex items-center gap-2 rounded-md px-3 py-2 font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
                            isWatched
                              ? 'cursor-not-allowed bg-slate-100 text-slate-500'
                              : 'cursor-pointer bg-red-100 text-[#D60000] hover:bg-red-200'
                          }`}
                        >
                          {isWatched ? <Check size={18} /> : <BookmarkPlus size={18} />}
                          {isWatched ? 'Added' : pendingId === section.id ? 'Adding…' : 'Add'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {results.length === 0 && (
              <p className="p-8 text-center text-slate-500">
                No matching course sections found.
              </p>
            )}
          </div>

          <nav aria-label="Search results pagination" className="mt-4 flex flex-wrap items-center justify-between gap-4">
            <p role="status" className="text-slate-600">
              Page {Math.floor(pagination.offset / pagination.limit) + 1} · {pagination.total} matching results
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                disabled={loading || pagination.offset === 0}
                onClick={() => search(submittedFilters, Math.max(0, pagination.offset - pagination.limit))}
                className="cursor-pointer rounded-md border border-slate-300 px-4 py-2 font-semibold hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={loading || pagination.offset + pagination.limit >= pagination.total}
                onClick={() => search(submittedFilters, pagination.offset + pagination.limit)}
                className="cursor-pointer rounded-md border border-slate-300 px-4 py-2 font-semibold hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </nav>
        </div>
      )}
    </section>
  )
}
