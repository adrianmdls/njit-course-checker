import { Link, useLocation } from 'react-router'
import { House, UserRound, LogOut } from 'lucide-react'

export default function Header() {
  const location = useLocation()
  const isAuthPage = ['/login', '/register'].includes(location.pathname)

  return (
    <header className="bg-white border-b border-slate-200">
      <div className="max-w-[1800px] mx-auto px-6 md:px-12 h-20 flex items-center justify-between">
        <Link to="/login" className="text-xl md:text-3xl font-bold text-[#0B1733]">
          <span className="text-[#D60000]">NJIT</span>{' '}
          Course Availability Checker
        </Link>

        <nav className="flex items-center gap-3">
          {isAuthPage ? (
            <>
              <Link to="/login" className="border border-slate-300 rounded-md px-5 py-3 font-medium hover:bg-slate-50">
                Login
              </Link>
              <Link to="/register" className="border border-slate-300 rounded-md px-5 py-3 font-medium hover:bg-slate-50">
                Register
              </Link>
            </>
          ) : (
            <>
              <Link to="/dashboard" className="border border-slate-300 rounded-md px-5 py-3 flex items-center gap-2">
                <House size={20} /> Home
              </Link>
              <Link to="/account" className="border border-slate-300 rounded-md px-5 py-3 flex items-center gap-2">
                <UserRound size={20} /> Account
              </Link>
              <Link to="/login" className="bg-[#D60000] text-white rounded-md px-5 py-3 flex items-center gap-2">
                <LogOut size={20} /> Logout
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  )
}