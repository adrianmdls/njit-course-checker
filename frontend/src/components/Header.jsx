import { Link, useLocation } from 'react-router'
import { House, UserRound, LogOut } from 'lucide-react'

export default function Header() {
  const location = useLocation()
  const isAuthPage = ['/login', '/register'].includes(location.pathname)

  const navButton =
    'inline-flex items-center justify-center gap-2 rounded-md border border-slate-300 px-4 py-2.5 font-medium transition-colors hover:bg-slate-50'

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex min-h-20 max-w-[1800px] flex-col items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:flex-row lg:px-12">
        <Link
          to="/login"
          className="text-center text-xl font-bold text-[#0B1733] sm:text-2xl lg:text-3xl"
        >
          <span className="text-[#D60000]">NJIT</span>{' '}
          Course Availability Checker
        </Link>

        <nav
          aria-label="Main navigation"
          className="flex flex-wrap items-center justify-center gap-2 sm:gap-3"
        >
          {isAuthPage ? (
            <>
              <Link to="/login" className={navButton}>
                Login
              </Link>

              <Link to="/register" className={navButton}>
                Register
              </Link>
            </>
          ) : (
            <>
              <Link to="/dashboard" className={navButton}>
                <House size={20} />
                Home
              </Link>

              <Link to="/account" className={navButton}>
                <UserRound size={20} />
                Account
              </Link>

              <Link
                to="/login"
                className="inline-flex items-center justify-center gap-2 rounded-md bg-[#D60000] px-4 py-2.5 font-medium text-white transition-colors hover:bg-red-700"
              >
                <LogOut size={20} />
                Logout
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  )
}
