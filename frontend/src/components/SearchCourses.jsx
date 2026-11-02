
import { useState } from 'react'
import { Search, BookmarkPlus, Check } from 'lucide-react'

const sampleSections = [
  { crn: '94243', course: 'IT 101', section: '001', max: 35, now: 28 },
  { crn: '95061', course: 'PHIL 337', section: 'W01', max: 30, now: 12 },
  { crn: '90123', course: 'CS 331', section: '001', max: 30, now: 30 },
  { crn: '87712', course: 'MATH 333', section: '001', max: 40, now: 40 },
  { crn: '83901', course: 'IT 202', section: '002', max: 25, now: 3 },
  { crn: '81234', course: 'CS 280', section: '004', max: 35, now: 5 },
  { crn: '79011', course: 'IT 352', section: '001', max: 30, now: 30 },
  { crn: '76890', course: 'CS 350', section: '002', max: 40, now: 12 },
]

const departments = ['CS', 'IT', 'MATH', 'PHIL']

export default function SearchCourses({ courses, onAdd }) {
  const [term, setTerm] = useState('2027-spring')
  const [department, setDepartment] = useState('')
  const [courseNumber, setCourseNumber] = useState('')
  const [results, setResults] = useState(null)

  function handleSearch(event) {
    event.preventDefault()

    const query = courseNumber.trim()

    const filtered = sampleSections.filter((section) => {
      const [subject, number] = section.course.split(' ')

      return (
        (!department || subject === department) &&
        (!query || number.startsWith(query))
      )
    })

    setResults(filtered)
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
            onChange={(event) => setTerm(event.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-4 py-3"
          >
            <option value="2026-fall">Fall 2026</option>
            <option value="2026-winter">Winter 2026–2027</option>
            <option value="2027-spring">Spring 2027</option>
          </select>
        </div>

        <div>
          <label htmlFor="search-department" className="mb-2 block font-semibold">
            Department
          </label>
          <select
            id="search-department"
            value={department}
            onChange={(event) => setDepartment(event.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-4 py-3"
          >
            <option value="">All Departments</option>
            {departments.map((subject) => (
              <option key={subject} value={subject}>
                {subject}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="search-number" className="mb-2 block font-semibold">
            Course Number
          </label>
          <input
            id="search-number"
            type="text"
            value={courseNumber}
            onChange={(event) => setCourseNumber(event.target.value)}
            placeholder="e.g., 280"
            className="w-full rounded-md border border-slate-300 bg-white px-4 py-3"
          />
        </div>

        <button
          type="submit"
          className="flex cursor-pointer items-center justify-center gap-2 rounded-md bg-[#D60000] px-6 py-3 font-semibold text-white hover:bg-red-700 md:col-span-3"
        >
          <Search size={20} />
          Search Courses
        </button>
      </form>

      {results !== null && (
        <div className="mt-8">
          <h2 className="mb-4 text-xl font-bold">
            Search Results ({results.length})
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
                  const isOpen = section.now < section.max
                  const isWatched = courses.some(
                    (course) => course.crn === section.crn
                  )

                  return (
                    <tr key={section.crn} className="border-t border-slate-200">
                      <td className="px-5 py-3">{section.crn}</td>
                      <td className="px-5 py-3 font-bold">{section.course}</td>
                      <td className="px-5 py-3">{section.section}</td>
                      <td className="px-5 py-3">{section.max}</td>
                      <td className="px-5 py-3">{section.now}</td>

                      <td className="px-5 py-3">
                        <span className={`inline-block min-w-[85px] rounded-md px-3 py-2 text-center font-semibold ${
                          isOpen
                            ? 'bg-green-100 text-green-700'
                            : 'bg-red-100 text-red-600'
                        }`}>
                          {isOpen ? 'Open' : 'Full'}
                        </span>
                      </td>

                      <td className="px-5 py-3">
                        <button
                          type="button"
                          disabled={isWatched}
                          onClick={() => onAdd(section)}
                          className={`flex items-center gap-2 rounded-md px-3 py-2 font-semibold ${
                            isWatched
                              ? 'cursor-not-allowed bg-slate-100 text-slate-500'
                              : 'cursor-pointer bg-red-100 text-[#D60000] hover:bg-red-200'
                          }`}
                        >
                          {isWatched ? <Check size={18} /> : <BookmarkPlus size={18} />}
                          {isWatched ? 'Added' : 'Add'}
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
        </div>
      )}
    </section>
  )
}
