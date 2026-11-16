import { useAuth } from '../auth'

export default function Account() {
  const { user } = useAuth()

  return (
    <div className="flex min-h-[calc(100vh-80px)] items-center justify-center px-4 py-10">
      <div className="w-full max-w-[545px] rounded-xl bg-white px-9 py-10 shadow-sm">
        <h1 className="mb-8 text-center text-4xl font-bold text-[#0B1733]">
          Account Settings
        </h1>

        <div className="space-y-6">
          <div>
            <label htmlFor="account-username" className="mb-2 block font-semibold text-[#0B1733]">
              Username
            </label>
            <input
              id="account-username"
              type="text"
              value={user.username}
              readOnly
              className="w-full rounded-md border border-slate-300 px-4 py-3 text-base outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
            />
          </div>

          <div>
            <label htmlFor="account-email" className="mb-2 block font-semibold text-[#0B1733]">
              Email Address
            </label>
            <input
              id="account-email"
              type="email"
              value={user.email}
              readOnly
              className="w-full rounded-md border border-slate-300 px-4 py-3 text-base outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
