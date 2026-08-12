import React, { useState } from 'react'
import { login } from '../api'

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async e => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const data = await login(username, password)
      onLogin(data.token, data.user)
    } catch {
      setError('Invalid username or password')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="loading" style={{ flexDirection: 'column', gap: '0' }}>
      <div style={{ width: '100%', maxWidth: 360 }}>
        <div style={{ marginBottom: '1.5rem', textAlign: 'center' }}>
          <div style={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--accent)', marginBottom: '0.3rem' }}>Tesla</div>
          <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text)' }}>Dashboard</div>
        </div>
        <form onSubmit={handleSubmit} className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div>
            <div className="section-title" style={{ marginBottom: '0.4rem' }}>Username</div>
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', padding: '0.5rem 0.75rem', fontSize: '0.9rem', boxSizing: 'border-box' }}
            />
          </div>
          <div>
            <div className="section-title" style={{ marginBottom: '0.4rem' }}>Password</div>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', padding: '0.5rem 0.75rem', fontSize: '0.9rem', boxSizing: 'border-box' }}
            />
          </div>
          {error && <p style={{ color: 'var(--red)', fontSize: '0.75rem', margin: 0 }}>{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="refresh-btn"
            style={{ width: '100%', padding: '0.6rem', fontSize: '0.7rem', marginTop: '0.25rem' }}
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  )
}
