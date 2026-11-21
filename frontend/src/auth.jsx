/* eslint-disable react/only-export-components -- Keep the small auth context and its helpers together. */
import { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react'
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
  // Session reads may only update the auth generation in which they started.
  const generation = useRef(0)
  const sessionRequest = useRef(0)
  const refresh = useCallback(async () => {
    const version = generation.current
    const request = ++sessionRequest.current
    const current = () => version === generation.current && request === sessionRequest.current
    setLoading(true)
    setError('')
    try {
      const data = await authRequest('me')
      if (current()) setUser(data.user)
    }
    catch (failure) {
      if (!current()) return
      setUser(null)
      if (failure.status !== 401) setError('Unable to check your session. Please retry.')
    } finally { if (current()) setLoading(false) }
  }, [])
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- Restore the server session on mount.
    refresh()
    return () => { sessionRequest.current += 1 }
  }, [refresh])
  async function login(identifier, password) {
    const version = ++generation.current
    try {
      const data = await authRequest('login', { identifier, password })
      if (version !== generation.current) return
      setUser(data.user)
      setError('')
    } finally {
      if (version === generation.current) {
        // Also invalidate session reads started while this mutation was pending.
        generation.current += 1
        setLoading(false)
      }
    }
  }
  async function logout() {
    const version = ++generation.current
    try {
      await authRequest('logout', {})
      if (version !== generation.current) return
      setUser(null)
      setError('')
    } finally {
      if (version === generation.current) {
        generation.current += 1
        setLoading(false)
      }
    }
  }
  return <AuthContext.Provider value={{ user, loading, error, refresh, login, logout }}>{children}</AuthContext.Provider>
}
export function useAuth() { return useContext(AuthContext) }
export function RequireAuth() {
  const { user, loading, error, refresh } = useAuth()
  if (loading) return <p role="status" className="p-10">Checking session…</p>
  if (error) return <div className="p-10"><p role="alert">{error}</p><button onClick={refresh}>Retry</button></div>
  return user ? <Outlet /> : <Navigate to="/login" replace />
}
