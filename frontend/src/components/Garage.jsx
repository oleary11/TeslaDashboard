import React, { useEffect, useState } from 'react'
import { fetchGarage } from '../api'

const fmt = (v, unit = '', decimals = 0) =>
  v != null ? `${typeof v === 'number' ? v.toFixed(decimals) : v}${unit}` : '—'

export default function Garage({ currentUser }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchGarage().then(setData).catch(() => setError('Failed to load garage'))
  }, [])

  if (error) return <p className="empty">{error}</p>
  if (!data) return <p className="empty">Loading…</p>
  if (!data.length) return <p className="empty">No members have data yet.</p>

  return (
    <div>
      {data.map(u => (
        <div key={u.user_id} className="card" style={{ marginBottom: '1rem' }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
            {u.username}
            {currentUser?.id === u.user_id && (
              <span className="badge badge-1">You</span>
            )}
            {u.display_name && u.display_name !== u.username && (
              <span style={{ color: 'var(--text-2)', fontWeight: 400, textTransform: 'none', letterSpacing: 0, fontSize: '0.75rem' }}>
                {u.display_name}
              </span>
            )}
          </h2>
          {(u.model || u.year) && (
            <p style={{ color: 'var(--text-3)', fontSize: '0.7rem', margin: '0 0 0.75rem' }}>
              {[u.year, u.model].filter(Boolean).join(' ')}
            </p>
          )}

          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            {u.compositor_url && (
              <div style={{
                flexShrink: 0, width: 160, background: '#0a0a0a',
                border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <img
                  src={u.compositor_url}
                  alt="Vehicle render"
                  style={{ width: '100%', display: 'block' }}
                />
              </div>
            )}
            <div className="stat-grid" style={{ marginBottom: 0, flex: 1 }}>
              <div className="stat">
                <div className="val">{u.odometer != null ? u.odometer.toLocaleString() : '—'}</div>
                <div className="lbl">Odometer mi</div>
              </div>
              <div className="stat">
                <div className="val">{fmt(u.top_speed, ' mph')}</div>
                <div className="lbl">Top Speed</div>
              </div>
              <div className="stat">
                <div className="val">{fmt(u.best_0_to_60, 's', 2)}</div>
                <div className="lbl">Best 0–60</div>
              </div>
              <div className="stat">
                <div className={`val ${u.battery_health_pct != null ? (u.battery_health_pct >= 90 ? 'green' : u.battery_health_pct >= 75 ? '' : 'red') : 'muted'}`}>
                  {fmt(u.battery_health_pct, '%', 1)}
                </div>
                <div className="lbl">Battery Health</div>
              </div>
              <div className="stat">
                <div className="val muted">{fmt(u.avg_wh_per_mile, ' Wh/mi')}</div>
                <div className="lbl">Avg Efficiency</div>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
