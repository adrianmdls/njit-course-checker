
import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  function handleSubmit(event) {
    event.preventDefault()
    // Authentication will be implemented in Milestone 2.
  }

  return (
    <div className="flex min-h-[calc(100vh-80px)] items-center justify-center px-4 py-10">
      <div className="w-full max-w-[545px] rounded-xl bg-white px-9 py-10 shadow-sm">
        <h1 className="mb-8 text-center text-4xl font-bold text-[#0B1733]">
          Login
        </h1>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label
              htmlFor="username"
              className="mb-2 block font-semibold text-[#0B1733]"
            >
              Username / Email
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              placeholder="Enter your username or email"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              className="w-full rounded-md border border-slate-300 px-4 py-3 text-base outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="mb-2 block font-semibold text-[#0B1733]"
            >
              Password
            </label>

            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                className="w-full rounded-md border border-slate-300 px-4 py-3 pr-12 text-base outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
              />

              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute inset-y-0 right-4 flex items-center cursor-pointer text-slate-400 hover:text-slate-600"
              >
                {showPassword ? <EyeOff size={22} /> : <Eye size={22} />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            className="w-full cursor-pointer rounded-md bg-[#D60000] px-4 py-3 font-semibold text-white transition-colors hover:bg-red-700"
          >
            Login
          </button>
        </form>
      </div>
    </div>
  )
}
