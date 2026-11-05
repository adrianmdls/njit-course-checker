import { Outlet } from 'react-router'
import Header from '../components/Header'

export default function MainLayout() {
  return (
    <div className="min-h-screen bg-[#F5F7FA] text-[#0B1733]">
      <Header />
      <main>
        <Outlet />
      </main>
    </div>
  )
}