/* eslint-disable react/only-export-components -- Keep the small auth context and its helpers together. */
import { createContext, useContext, useEffect, useState } from 'react'
import { Navigate, Outlet } from 'react-router'

export async function authRequest(path, body) {
  const response = await fetch(`/api/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'NJIT-Course-Checker' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = response.status === 204 ? null : await response.json()
  if (!response.ok) {
    const error = new Error(data?.error || 'Request failed')
    error.status = response.status
    throw error
  }
  return data
}
const AuthContext = createContext(null)
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  async function refresh() {
    try { setUser((await authRequest('me')).user) }
    catch (failure) {
      setUser(null)
      if (failure.status !== 401) setError('Unable to check your session. Please retry.')
    } finally { setLoading(false) }
  }
  // eslint-disable-next-line react/set-state-in-effect -- Fetch the server session asynchronously on mount.
  useEffect(() => { refresh() }, [])
  async function login(identifier, password) {
    const data = await authRequest('login', { identifier, password })
    setUser(data.user)
  }
  async function logout() {
    await authRequest('logout', {})
    setUser(null)
  }
  return <AuthContext.Provider value={{ user, loading, error, refresh: () => { setLoading(true); setError(''); refresh() }, login, logout }}>{children}</AuthContext.Provider>
}
export function useAuth() { return useContext(AuthContext) }
export function RequireAuth() {
  const { user, loading, error, refresh } = useAuth()
  if (loading) return <p role="status" className="p-10">Checking session…</p>
  if (error) return <div className="p-10"><p role="alert">{error}</p><button onClick={refresh}>Retry</button></div>
  return user ? <Outlet /> : <Navigate to="/login" replace />
}
