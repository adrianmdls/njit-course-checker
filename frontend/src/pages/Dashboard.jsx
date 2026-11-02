
import { useState } from 'react'
import { Bookmark, Search, Bell, Trash2 } from 'lucide-react'
import { mockCourses } from '../data/mockCourses'

import SearchCourses from '../components/SearchCourses'

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState('watchlist')
  const [courses, setCourses] = useState(mockCourses)

  function toggleNotification(crn) {
    setCourses((current) =>
      current.map((course) =>
        course.crn === crn
          ? { ...course, notify: !course.notify }
          : course
      )
    )
  }

  function removeCourse(crn) {
    setCourses((current) =>
      current.filter((course) => course.crn !== crn)
    )
  }

  function addCourse(section) {
  setCourses((current) => {
    if (current.some((course) => course.crn === section.crn)) {
      return current
    }

    return [
      ...current,
      {
        ...section,
        checked: 'Not checked yet',
        notify: false,
      },
    ]
  })
}

  return (
    <div className="mx-auto w-full max-w-[1700px] px-4 py-10 md:px-12">
      <div className="rounded-xl bg-white px-5 py-6 shadow-sm md:px-8">

        
        {/* Dashboard tabs */}
        <div className="flex justify-center gap-3 border-b border-slate-200">
        {[
            { id: 'watchlist', label: 'Watchlist', Icon: Bookmark },
            { id: 'search', label: 'Search Courses', Icon: Search },
        ].map(({ id, label, Icon }) => (
            <div
            key={id}
            className={`border-b-[3px] pb-2 ${
                activeTab === id
                ? 'border-[#D60000]'
                : 'border-transparent'
            }`}
            >
            <button
                type="button"
                onClick={() => setActiveTab(id)}
                className={`flex min-h-[54px] cursor-pointer items-center justify-center gap-3 rounded-md px-6 text-lg font-semibold transition-colors sm:min-w-[275px] ${
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


        {activeTab === 'watchlist' ? (
          <div className="mt-6 overflow-x-auto rounded-md border border-slate-200">
            <table className="w-full min-w-[1000px] border-collapse text-left text-[#0B1733]">
              <thead className="bg-slate-50">
                <tr>
                  {['CRN', 'Course', 'Section', 'Max', 'Now', 'Status', 'Last Checked', 'Notify Email', 'Remove'].map((heading) => (
                    <th
                      key={heading}
                      className="px-5 py-4 text-sm font-semibold whitespace-nowrap"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {courses.map((course) => {
                  const isOpen = course.now < course.max

                  return (
                    <tr key={course.crn} className="border-t border-slate-200">
                      <td className="px-5 py-3">{course.crn}</td>

                      <td className="px-5 py-3 font-bold whitespace-nowrap">
                        {course.course}
                      </td>

                      <td className="px-5 py-3">{course.section}</td>
                      <td className="px-5 py-3">{course.max}</td>
                      <td className="px-5 py-3">{course.now}</td>

                      <td className="px-5 py-3">
                        <span
                          className={`inline-block min-w-[95px] rounded-md px-4 py-2 text-center font-semibold ${
                            isOpen
                              ? 'bg-green-100 text-green-700'
                              : 'bg-red-100 text-red-600'
                          }`}
                        >
                          {isOpen ? 'Open' : 'Full'}
                        </span>
                      </td>

                      <td className="px-5 py-3 whitespace-nowrap">
                        {course.checked}
                      </td>

                      <td className="px-5 py-3 text-center">
                        <button
                          type="button"
                          onClick={() => toggleNotification(course.crn)}
                          aria-label={`${course.notify ? 'Disable' : 'Enable'} email notifications for ${course.course}`}
                          aria-pressed={course.notify}
                          title={course.notify ? 'Notifications enabled (demo)' : 'Notifications disabled (demo)'}
                          className="cursor-pointer"
                        >
                          <Bell
                            size={25}
                            fill={course.notify ? 'currentColor' : 'none'}
                            className={course.notify ? 'text-[#D60000]' : 'text-slate-400'}
                          />
                        </button>
                      </td>

                      <td className="px-5 py-3 text-center">
                        <button
                          type="button"
                          onClick={() => removeCourse(course.crn)}
                          aria-label={`Remove ${course.course} from watchlist`}
                          className="cursor-pointer rounded-md bg-red-100 p-2 text-red-600 hover:bg-red-200"
                        >
                          <Trash2 size={20} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {courses.length === 0 && (
              <p className="p-10 text-center text-slate-500">
                Your watchlist is empty.
              </p>
            )}
          </div>
        ) : (
            <SearchCourses courses={courses} onAdd={addCourse} />
        )}
      </div>
    </div>
  )
}
