
import { useEffect, useRef, useState } from 'react'
import { Search, BookmarkPlus, Check } from 'lucide-react'
import { useAuth } from '../auth'
import departmentNames from '../data/departmentNames'
import { termLabel } from '../utils/courseFormatting'
import LastSeen from './LastSeen'
import CourseAvailabilityInfo from './CourseAvailabilityInfo'

const filterControlClass = 'h-12 w-full min-w-0 rounded-md border border-slate-300 bg-white px-4 text-base text-slate-900 outline-none focus:border-red-700 focus:ring-2 focus:ring-red-700/20 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-500'

export default function SearchCourses({ courses, onAdd, watchlistReady, pendingId }) {
  const { refresh } = useAuth()
  const [term, setTerm] = useState('')
  const [options, setOptions] = useState(null)
  const [optionsError, setOptionsError] = useState('')
  const [optionsAttempt, setOptionsAttempt] = useState(0)
  const [department, setDepartment] = useState('')
  const [departmentText, setDepartmentText] = useState('')
  const [departmentOpen, setDepartmentOpen] = useState(false)
  const [activeDepartment, setActiveDepartment] = useState(-1)
  const departmentInput = useRef(null)
  const departmentList = useRef(null)
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
  const selectedTerm = options?.terms.find(entry => entry.code === term)
  const departments = selectedTerm?.departments ?? []
  const canSearch = Boolean(selectedTerm) && departments.includes(department)

  const departmentLabel = code => departmentNames[code] ? `${code} — ${departmentNames[code]}` : code
  const normalizeDepartment = text => text.replace(/[–—]/g, ' ').trim().replace(/\s+/g, ' ').toLowerCase()
  const visibleDepartments = departments.filter(code =>
    normalizeDepartment(departmentLabel(code)).includes(normalizeDepartment(departmentText)))

  useEffect(() => {
    if (departmentOpen && activeDepartment >= 0) {
      departmentList.current?.children[activeDepartment]?.scrollIntoView({ block: 'nearest' })
    }
  }, [departmentOpen, activeDepartment])

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
          ? 'Check your search filters. Use a course number such as 280 for the selected department.'
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

  function clearSearch() {
    activeRequest.current?.abort()
    activeRequest.current = null
    setResults(null)
    setSubmittedFilters(null)
    setPagination({ limit: 50, offset: 0, total: 0 })
    setLoading(false)
    setError('')
  }

  function chooseDepartment(code) {
    if (code !== department) clearSearch()
    setDepartment(code)
    setDepartmentText('')
    setDepartmentOpen(false)
    setActiveDepartment(-1)
  }

  function handleSearch(event) {
    event.preventDefault()
    if (!canSearch) return
    const filters = { term, subject: department, sort, order }
    if (courseNumber.trim()) filters.query = courseNumber.trim().replace(/\s+/g, ' ').toUpperCase()
    if (status) filters.status = status
    setSubmittedFilters(filters)
    search(filters, 0)
  }

  return (
    <section className="mt-6">
      <form
        onSubmit={handleSearch}
        className="grid grid-cols-1 items-end gap-5 rounded-lg bg-slate-50 p-6 md:grid-cols-3"
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
              clearSearch()
              setTerm(code)
              const available = options?.terms.find(entry => entry.code === code)?.departments ?? []
              if (!available.includes(department)) setDepartment('')
              setDepartmentText('')
              setDepartmentOpen(false)
              setActiveDepartment(-1)
            }}
            className={filterControlClass}
          >
            {!options?.terms.length && <option value="">{options ? 'No local terms available' : 'Loading terms…'}</option>}
            {options?.terms.map(entry => <option key={entry.code} value={entry.code}>{termLabel(entry.code)}</option>)}
          </select>
        </div>

        <div className="relative min-w-0" onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setDepartmentOpen(false)
            setActiveDepartment(-1)
          }
        }}>
          <label htmlFor="search-department" className="mb-2 block font-semibold">Department</label>
          <div className="relative">
            <input
              ref={departmentInput}
              id="search-department"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={departmentOpen}
              aria-controls="department-options"
              aria-required="true"
              aria-describedby="department-help"
              aria-activedescendant={departmentOpen && activeDepartment >= 0 && visibleDepartments[activeDepartment]
                ? `department-option-${visibleDepartments[activeDepartment]}` : undefined}
              autoComplete="off"
              value={department ? departmentLabel(department) : departmentText}
              disabled={!selectedTerm || !departments.length}
              placeholder="Select department"
              onFocus={() => { setDepartmentOpen(true); setActiveDepartment(-1) }}
              onClick={() => setDepartmentOpen(true)}
              onChange={(event) => {
                clearSearch()
                setDepartment('')
                setDepartmentText(event.target.value)
                setDepartmentOpen(true)
                setActiveDepartment(-1)
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent?.isComposing) return
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  setDepartmentOpen(true)
                  const count = visibleDepartments.length
                  setActiveDepartment(count ? (activeDepartment < 0
                    ? event.key === 'ArrowDown' ? 0 : count - 1
                    : (activeDepartment + (event.key === 'ArrowDown' ? 1 : -1) + count) % count) : -1)
                } else if (event.key === 'Enter' && departmentOpen) {
                  event.preventDefault()
                  if (activeDepartment >= 0 && visibleDepartments[activeDepartment]) chooseDepartment(visibleDepartments[activeDepartment])
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setDepartmentOpen(false)
                  setActiveDepartment(-1)
                }
              }}
              className={`${filterControlClass} pr-12`}
            />
            {(department || departmentText) && <button
              type="button" aria-label="Clear department"
              onClick={() => { chooseDepartment(''); setDepartmentOpen(true); departmentInput.current?.focus() }}
              className="absolute inset-y-0 right-0 min-w-12 cursor-pointer rounded-r-md px-3 text-xl hover:bg-slate-100"
            >×</button>}
            {departmentOpen && <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
              <ul id="department-options" ref={departmentList} role="listbox" aria-label="Departments"
                className="max-h-44 overflow-y-auto">
                {visibleDepartments.map((code, index) => <li
                  key={code} id={`department-option-${code}`} role="option" aria-selected={department === code}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => { chooseDepartment(code); departmentInput.current?.focus() }}
                  className={`cursor-pointer px-4 py-2 text-sm leading-5 break-words hover:bg-red-50 ${activeDepartment === index ? 'bg-red-50 outline-2 outline-inset outline-red-700' : ''}`}
                >{departmentLabel(code)}</li>)}
              </ul>
              <p role="status" className="sr-only">{visibleDepartments.length ? `${visibleDepartments.length} departments available` : 'No matching departments'}</p>
              {!visibleDepartments.length && <p className="px-4 py-2 text-sm text-slate-600">No matching departments</p>}
            </div>}
          </div>
          <p id="department-help" className="sr-only">Type a code or name, then select a department.</p>
        </div>

        <div>
          <label htmlFor="search-number" className="mb-2 block font-semibold">
            Course Number (Optional)
          </label>
          <input
            id="search-number"
            type="text"
            maxLength={100}
            value={courseNumber}
            onChange={(event) => setCourseNumber(event.target.value)}
            placeholder="e.g., 280, 340, 490"
            className={filterControlClass}
          />
        </div>

        <div>
          <label htmlFor="search-status" className="mb-2 block font-semibold">Status</label>
          <select
            id="search-status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className={filterControlClass}
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
            className={filterControlClass}
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
            className={filterControlClass}
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </div>

        <button
          type="submit"
          disabled={loading || !canSearch}
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
      {options?.terms.length === 0 && <p role="status" className="mt-6 text-slate-500">No searchable local catalog data is available. No active sections are currently stored.</p>}
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

          <CourseAvailabilityInfo />
          <div className="overflow-x-auto rounded-md border border-slate-200">
            <table className="w-full min-w-[1000px] text-left">
              <thead className="bg-slate-50">
                <tr>
                  {['CRN', 'Course', 'Section', 'Capacity', 'Enrolled', 'Status', 'Last Seen', 'Watchlist'].map((heading) => (
                    <th key={heading} className={`px-5 py-4 text-sm font-semibold whitespace-nowrap ${['Capacity', 'Enrolled'].includes(heading) ? 'text-right' : ''}`} >
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
                    <tr key={section.id} className="border-t border-slate-200 hover:bg-slate-50">
                      <td className="px-5 py-3">{section.crn}</td>
                      <td className="px-5 py-3 font-bold whitespace-nowrap">{section.course}</td>
                      <td className="px-5 py-3">{section.section ?? '—'}</td>
                      <td className="px-5 py-3 text-right tabular-nums">{section.max ?? '—'}</td>
                      <td className="px-5 py-3 text-right tabular-nums">{section.now ?? '—'}</td>

                      <td className="px-5 py-3">
                        <span className={`inline-block min-w-[95px] rounded-md px-3 py-2 text-center font-semibold ${
                          section.status === 'OPEN'
                            ? 'bg-green-100 text-green-700'
                            : section.status === 'CLOSED'
                              ? 'bg-red-100 text-red-600'
                              : 'bg-slate-100 text-slate-600'
                        }`}>
                          {statusLabel}
                        </span>
                      </td>

                      <td className="px-5 py-3"><LastSeen timestamp={section.last_checked_at} /></td>

                      <td className="px-5 py-3">
                        <button
                          type="button"
                          disabled={isWatched || !watchlistReady || pendingId !== null}
                          onClick={() => onAdd(section)}
                          className={`flex items-center gap-2 rounded-md px-3 py-2 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:cursor-not-allowed disabled:opacity-60 ${
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
