import React, { useState, useEffect } from 'react'

export default function AuthSetup({ onAuth }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [noClientId, setNoClientId] = useState(false)
  const [redirectUri, setRedirectUri] = useState('https://your-domain.example/api/auth/callback')

  useEffect(() => {
    // Check if auth_error is in URL (returned from failed callback)
    if (window.location.search.includes('auth_error')) {
      setError('Authentication failed — please try again')
      window.history.replaceState({}, '', '/')
    }
    // Check if client_id is configured
    fetch('/api/config').then(r => r.json()).then(cfg => {
      if (!cfg.client_id_set) setNoClientId(true)
      if (cfg.redirect_uri) setRedirectUri(cfg.redirect_uri)
    }).catch(() => {})
  }, [])

  const handleConnect = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/auth/url')
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
      } else {
        setError('Could not generate auth URL')
        setLoading(false)
      }
    } catch {
      setError('Backend unreachable')
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '2rem' }}>
      <div style={{ maxWidth: 520, width: '100%' }}>
        <h1 style={{ color: '#e8c84e', marginBottom: '0.5rem' }}>⚡ Tesla Dashboard</h1>
        <p style={{ color: '#7986cb', marginBottom: '2rem' }}>Connect your Tesla account to get started</p>

        {noClientId ? (
          <div style={{ background: '#0d0d1a', border: '1px solid #3d2b00', borderRadius: 12, padding: '1.5rem' }}>
            <p style={{ color: '#ffcc80', fontWeight: 700, marginBottom: '1rem' }}>Setup required — Tesla Developer App</p>
            <p style={{ color: '#9fa8da', fontSize: '0.875rem', lineHeight: 1.7, marginBottom: '1.25rem' }}>
              Tesla now requires a registered developer application to access vehicle data.
              This is free and takes about 2 minutes:
            </p>
            <ol style={{ color: '#7986cb', fontSize: '0.875rem', lineHeight: 2.2, paddingLeft: '1.25rem', marginBottom: '1.5rem' }}>
              <li>Go to <strong style={{ color: '#e8c84e' }}>developer.tesla.com</strong> → sign in</li>
              <li>Click <strong style={{ color: '#e8c84e' }}>Add Application</strong></li>
              <li>Name it anything (e.g. "My Dashboard"), set type to <strong style={{ color: '#e8c84e' }}>Web App</strong></li>
              <li>Add redirect URI: <code style={{ background: '#111', padding: '2px 6px', borderRadius: 4, color: '#80cbc4', fontSize: '0.8rem' }}>{redirectUri}</code></li>
              <li>Copy the <strong style={{ color: '#e8c84e' }}>Client ID</strong></li>
              <li>SSH to your server and edit the project&apos;s <code style={{ background: '#111', padding: '2px 6px', borderRadius: 4, color: '#80cbc4', fontSize: '0.8rem' }}>.env</code> file</li>
              <li>Set <code style={{ background: '#111', padding: '2px 6px', borderRadius: 4, color: '#80cbc4', fontSize: '0.8rem' }}>TESLA_CLIENT_ID=&lt;your-client-id&gt;</code></li>
              <li>Run <code style={{ background: '#111', padding: '2px 6px', borderRadius: 4, color: '#80cbc4', fontSize: '0.8rem' }}>docker compose up -d --build</code> in the tesla folder</li>
            </ol>
            <p style={{ color: '#546e7a', fontSize: '0.8rem' }}>Then reload this page to connect.</p>
          </div>
        ) : (
          <div style={{ background: '#0d0d1a', border: '1px solid #1a1a2e', borderRadius: 12, padding: '1.5rem' }}>
            <p style={{ color: '#9fa8da', marginBottom: '1.5rem', fontSize: '0.9rem', lineHeight: 1.6 }}>
              Click below to sign in with your Tesla account. You'll be redirected to Tesla's
              official login page, then brought back here automatically.
            </p>
            {error && <p style={{ color: '#ef9a9a', fontSize: '0.85rem', marginBottom: '1rem' }}>{error}</p>}
            <button
              onClick={handleConnect}
              disabled={loading}
              style={{
                background: loading ? '#555' : '#e8c84e',
                color: '#0a0a0f',
                border: 'none',
                borderRadius: 8,
                padding: '0.75rem 1.5rem',
                fontWeight: 700,
                cursor: loading ? 'not-allowed' : 'pointer',
                width: '100%',
                fontSize: '1rem',
              }}
            >
              {loading ? 'Redirecting to Tesla…' : 'Connect with Tesla'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
