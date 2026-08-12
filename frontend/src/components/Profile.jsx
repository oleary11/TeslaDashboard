import React, { useEffect, useState, useRef, useCallback } from 'react'
import { fetchAuthStatus, fetchVehicle, fetchAuthUrl, fetchAuthCredentials, saveAuthCredentials, updateMyVisibility, updateMyLocation } from '../api'

function AddressInput({ label, isSet, onSelect }) {
  const [value, setValue] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const debounce = useRef(null)
  const wrapRef = useRef(null)

  const search = useCallback((q) => {
    if (q.length < 4) { setSuggestions([]); setOpen(false); return }
    setLoading(true)
    fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&addressdetails=1`, {
      headers: { 'Accept-Language': 'en' }
    })
      .then(r => r.json())
      .then(data => {
        setSuggestions(data)
        setOpen(data.length > 0)
      })
      .catch(() => setSuggestions([]))
      .finally(() => setLoading(false))
  }, [])

  const handleChange = (e) => {
    const v = e.target.value
    setValue(v)
    clearTimeout(debounce.current)
    debounce.current = setTimeout(() => search(v), 350)
  }

  const handleSelect = (item) => {
    setValue(item.display_name)
    setSuggestions([])
    setOpen(false)
    onSelect({ lat: parseFloat(item.lat), lon: parseFloat(item.lon), display: item.display_name })
  }

  useEffect(() => {
    const handler = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.3rem' }}>
        <span className="section-title" style={{ fontSize: '0.72rem' }}>{label}</span>
        {isSet && <span className="badge badge-1" style={{ fontSize: '0.65rem' }}>Set</span>}
      </div>
      <div style={{ position: 'relative' }}>
        <input
          className="input"
          value={value}
          onChange={handleChange}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          placeholder="Start typing an address…"
          autoComplete="off"
        />
        {loading && (
          <span style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)', fontSize: '0.7rem' }}>
            …
          </span>
        )}
      </div>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
          background: 'var(--surface)', border: '1px solid var(--border)',
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)', maxHeight: 220, overflowY: 'auto',
        }}>
          {suggestions.map((s, i) => (
            <div
              key={i}
              onMouseDown={() => handleSelect(s)}
              style={{
                padding: '0.5rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem',
                color: 'var(--text-2)', borderBottom: '1px solid var(--border)',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
              onMouseLeave={e => e.currentTarget.style.background = ''}
            >
              {s.display_name}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function reverseGeocode(lat, lon) {
  return fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`, {
    headers: { 'Accept-Language': 'en' }
  }).then(r => r.json()).then(d => d.display_name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`)
}

export default function Profile({ user, onVisibilityChange }) {
  const [teslaAuthed, setTeslaAuthed] = useState(null)
  const [vehicle, setVehicle] = useState(null)
  const [visible, setVisible] = useState(user?.visible_in_garage ?? true)
  const [connecting, setConnecting] = useState(false)
  const [saving, setSaving] = useState(false)

  const [homeCoords, setHomeCoords] = useState(null)
  const [workCoords, setWorkCoords] = useState(null)
  const [locSaving, setLocSaving] = useState(false)
  const [locSaved, setLocSaved] = useState(false)
  const [locError, setLocError] = useState('')
  const [homeSet, setHomeSet] = useState(!!user?.home_lat)
  const [workSet, setWorkSet] = useState(!!user?.work_lat)
  const [homeDisplay, setHomeDisplay] = useState('')
  const [workDisplay, setWorkDisplay] = useState('')

  useEffect(() => {
    if (user?.home_lat && user?.home_lon)
      reverseGeocode(user.home_lat, user.home_lon).then(setHomeDisplay).catch(() => {})
    if (user?.work_lat && user?.work_lon)
      reverseGeocode(user.work_lat, user.work_lon).then(setWorkDisplay).catch(() => {})
  }, [user?.home_lat, user?.work_lat])

  const [hasOwnCreds, setHasOwnCreds] = useState(false)
  const [showCredForm, setShowCredForm] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [credSaving, setCredSaving] = useState(false)
  const [credError, setCredError] = useState('')

  useEffect(() => {
    fetchAuthStatus()
      .then(s => setTeslaAuthed(s.authenticated))
      .catch(() => setTeslaAuthed(false))
    fetchVehicle()
      .then(setVehicle)
      .catch(() => setVehicle(null))
    fetchAuthCredentials()
      .then(d => setHasOwnCreds(d.has_own_credentials))
      .catch(() => {})
  }, [])

  const handleVisibilityToggle = async () => {
    const next = !visible
    setSaving(true)
    try {
      await updateMyVisibility(next)
      setVisible(next)
      onVisibilityChange(next)
    } catch {}
    setSaving(false)
  }

  const handleSaveLocation = async (e) => {
    e.preventDefault()
    setLocError('')
    if (!homeCoords && !workCoords) { setLocError('Select at least one address from the dropdown'); return }
    setLocSaving(true)
    try {
      await updateMyLocation(
        homeCoords?.lat ?? null, homeCoords?.lon ?? null,
        workCoords?.lat ?? null, workCoords?.lon ?? null
      )
      if (homeCoords) setHomeSet(true)
      if (workCoords) setWorkSet(true)
      setHomeCoords(null)
      setWorkCoords(null)
      setLocSaved(true)
      setTimeout(() => setLocSaved(false), 2500)
    } catch {
      setLocError('Failed to save')
    }
    setLocSaving(false)
  }

  const handleSaveCreds = async (e) => {
    e.preventDefault()
    setCredError('')
    if (!clientId.trim()) { setCredError('Client ID is required'); return }
    setCredSaving(true)
    try {
      await saveAuthCredentials(clientId.trim(), clientSecret.trim())
      setHasOwnCreds(true)
      setShowCredForm(false)
      setClientId('')
      setClientSecret('')
    } catch {
      setCredError('Failed to save credentials')
    }
    setCredSaving(false)
  }

  const handleConnect = async () => {
    setConnecting(true)
    try {
      const data = await fetchAuthUrl()
      if (data.url) window.location.href = data.url
    } catch (err) {
      const body = await err.json?.().catch(() => ({}))
      alert(body?.detail || 'Failed to get auth URL — make sure your credentials are saved first')
    }
    setConnecting(false)
  }

  return (
    <div>
      <div className="card">
        <h2>Account</h2>
        <div className="stat-grid" style={{ marginBottom: 0 }}>
          <div className="stat">
            <div className="val muted" style={{ fontSize: '1.1rem' }}>{user?.username}</div>
            <div className="lbl">Username</div>
          </div>
          <div className="stat">
            <div className={`val ${user?.is_admin ? 'accent' : 'muted'}`} style={{ fontSize: '1rem' }}>
              {user?.is_admin ? 'Admin' : 'Member'}
            </div>
            <div className="lbl">Role</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Garage Visibility</h2>
        <p style={{ color: 'var(--text-2)', fontSize: '0.8rem', marginBottom: '1rem' }}>
          When visible, your stats appear on the Garage tab for all members.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <button
            className="refresh-btn"
            onClick={handleVisibilityToggle}
            disabled={saving}
            style={{ padding: '0.4rem 1rem' }}
          >
            {saving ? 'Saving…' : visible ? 'Visible — click to hide' : 'Hidden — click to show'}
          </button>
          <span className={`badge ${visible ? 'badge-1' : 'badge-gray'}`}>
            {visible ? 'Visible' : 'Hidden'}
          </span>
        </div>
      </div>

      <div className="card">
        <h2>Home & Work</h2>
        <p style={{ color: 'var(--text-3)', fontSize: '0.78rem', marginBottom: '1rem' }}>
          Used for commute detection. You only need to update an address if it changes.
        </p>
        <form onSubmit={handleSaveLocation} style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', maxWidth: 420 }}>
          <div>
            <AddressInput label="Home Address" isSet={homeSet} onSelect={setHomeCoords} />
            {homeDisplay && (
              <p style={{ color: 'var(--text-3)', fontSize: '0.72rem', margin: '0.25rem 0 0', lineHeight: 1.4 }}>
                Current: {homeDisplay}
              </p>
            )}
          </div>
          <div>
            <AddressInput label="Work Address" isSet={workSet} onSelect={setWorkCoords} />
            {workDisplay && (
              <p style={{ color: 'var(--text-3)', fontSize: '0.72rem', margin: '0.25rem 0 0', lineHeight: 1.4 }}>
                Current: {workDisplay}
              </p>
            )}
          </div>
          {locError && <p style={{ color: 'var(--red)', fontSize: '0.78rem', margin: 0 }}>{locError}</p>}
          <button className="refresh-btn" type="submit" disabled={locSaving || (!homeCoords && !workCoords)} style={{ alignSelf: 'flex-start', padding: '0.4rem 1rem' }}>
            {locSaved ? 'Saved!' : locSaving ? 'Saving…' : 'Save'}
          </button>
        </form>
      </div>

      <div className="card">
        <h2>Tesla Connection</h2>

        <div style={{ marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
            <span style={{ color: 'var(--text-2)', fontSize: '0.85rem' }}>Fleet API credentials</span>
            <span className={`badge ${hasOwnCreds ? 'badge-1' : 'badge-gray'}`}>
              {hasOwnCreds ? 'Connected' : 'Not set'}
            </span>
          </div>
          <p style={{ color: 'var(--text-3)', fontSize: '0.78rem', marginBottom: '0.75rem' }}>
            {user?.is_admin
              ? "You are using the server's Tesla app credentials by default."
              : 'You must register your own free app at developer.tesla.com and enter your '}
            {!user?.is_admin && <><strong style={{ color: 'var(--text-2)' }}>client_id</strong> and{' '}
            <strong style={{ color: 'var(--text-2)' }}>client_secret</strong> below before connecting your Tesla.</>}
          </p>
          <button
            className="refresh-btn"
            onClick={() => setShowCredForm(v => !v)}
            style={{ padding: '0.3rem 0.8rem', fontSize: '0.8rem' }}
          >
            {showCredForm ? 'Cancel' : hasOwnCreds ? 'Update credentials' : 'Enter credentials'}
          </button>

          {showCredForm && (
            <form onSubmit={handleSaveCreds} style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.6rem', maxWidth: 400 }}>
              <input className="input" placeholder="Client ID" value={clientId} onChange={e => setClientId(e.target.value)} autoComplete="off" />
              <input className="input" placeholder="Client Secret" type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} autoComplete="off" />
              {credError && <p style={{ color: 'var(--red)', fontSize: '0.78rem' }}>{credError}</p>}
              <button className="refresh-btn" type="submit" disabled={credSaving} style={{ alignSelf: 'flex-start' }}>
                {credSaving ? 'Saving…' : 'Save credentials'}
              </button>
            </form>
          )}
        </div>

        {teslaAuthed === null ? (
          <p style={{ color: 'var(--text-3)', fontSize: '0.8rem' }}>Checking…</p>
        ) : teslaAuthed ? (
          <div>
            <p style={{ color: 'var(--green)', fontSize: '0.8rem', marginBottom: '0.75rem' }}>Connected</p>
            {vehicle && (
              <p style={{ color: 'var(--text-2)', fontSize: '0.8rem' }}>
                {[vehicle.year, vehicle.model, vehicle.display_name].filter(Boolean).join(' · ')}
              </p>
            )}
            <button className="refresh-btn" onClick={handleConnect} disabled={connecting} style={{ marginTop: '0.75rem' }}>
              {connecting ? 'Redirecting…' : 'Re-connect Tesla'}
            </button>
          </div>
        ) : (
          <div>
            <p style={{ color: 'var(--text-3)', fontSize: '0.8rem', marginBottom: '0.75rem' }}>Not connected</p>
            <button className="refresh-btn" onClick={handleConnect} disabled={connecting}>
              {connecting ? 'Redirecting…' : 'Connect Tesla'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
