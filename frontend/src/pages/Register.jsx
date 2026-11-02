
import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

export default function Register() {
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [error, setError] = useState('')

  function handleSubmit(event) {
    event.preventDefault()

    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setError('')
    // Account creation will be implemented in Milestone 2.
  }

  return (
    <div className="flex min-h-[calc(100vh-80px)] items-center justify-center px-4 py-10">
      <div className="w-full max-w-[545px] rounded-xl bg-white px-9 py-9 shadow-sm">
        <h1 className="mb-7 text-center text-4xl font-bold text-[#0B1733]">
          Register
        </h1>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="register-username" className="mb-2 block font-semibold text-[#0B1733]">
              Username
            </label>
            <input
              id="register-username"
              type="text"
              autoComplete="username"
              placeholder="Enter your username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              className="w-full rounded-md border border-slate-300 px-4 py-3 outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
            />
          </div>

          <div>
            <label htmlFor="register-email" className="mb-2 block font-semibold text-[#0B1733]">
              Email
            </label>
            <input
              id="register-email"
              type="email"
              autoComplete="email"
              placeholder="Enter your email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              className="w-full rounded-md border border-slate-300 px-4 py-3 outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
            />
          </div>

          <div>
            <label htmlFor="register-password" className="mb-2 block font-semibold text-[#0B1733]">
              Password
            </label>
            <div className="relative">
              <input
                id="register-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder="Enter your password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                className="w-full rounded-md border border-slate-300 px-4 py-3 pr-12 outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute inset-y-0 right-4 flex cursor-pointer items-center text-slate-400 hover:text-slate-600"
              >
                {showPassword ? <EyeOff size={22} /> : <Eye size={22} />}
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="register-confirm" className="mb-2 block font-semibold text-[#0B1733]">
              Confirm Password
            </label>
            <div className="relative">
              <input
                id="register-confirm"
                type={showConfirmPassword ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder="Confirm your password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
                className="w-full rounded-md border border-slate-300 px-4 py-3 pr-12 outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                className="absolute inset-y-0 right-4 flex cursor-pointer items-center text-slate-400 hover:text-slate-600"
              >
                {showConfirmPassword ? <EyeOff size={22} /> : <Eye size={22} />}
              </button>
            </div>
          </div>

          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="w-full cursor-pointer rounded-md bg-[#D60000] px-4 py-3 font-semibold text-white transition-colors hover:bg-red-700"
          >
            Register
          </button>
        </form>
      </div>
    </div>
  )
}
