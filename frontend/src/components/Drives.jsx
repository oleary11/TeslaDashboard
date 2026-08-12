import React, { useEffect, useState } from 'react'
import { fetchDrives, fetchEfficiency, fetchAccelerationRuns, fetchTelemetryTopSpeed, fetchMonthlyDrives, fetchDestinations, fetchSpeedHistogram } from '../api'
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine, ResponsiveContainer, Cell } from 'recharts'
import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import DriveMap from './DriveMap'
import { fmtDate, fmtDateTime } from '../fmt'

const TT = {
  contentStyle: { background: '#111', border: '1px solid #222', borderRadius: 0, fontSize: '0.75rem' },
  labelStyle: { color: '#666', fontSize: '0.65rem', marginBottom: '0.2rem' },
  cursor: { stroke: '#333' },
}

const fmtDuration = s => {
  if (!s) return '—'
  const m = Math.floor(s / 60), h = Math.floor(m / 60)
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m ${s % 60}s`
}

export default function Drives() {
  const [drives, setDrives] = useState([])
  const [efficiency, setEfficiency] = useState([])
  const [effPeriod, setEffPeriod] = useState('All')
  const [runs, setRuns] = useState([])
  const [telTopSpeed, setTelTopSpeed] = useState(null)
  const [monthly, setMonthly] = useState([])
  const [destinations, setDestinations] = useState([])
  const [speedBands, setSpeedBands] = useState([])

  useEffect(() => {
    fetchDrives().then(setDrives)
    fetchEfficiency().then(rows => setEfficiency(rows.map(r => ({
      ...r,
      date: new Date(r.start_time).toLocaleDateString('en-US', { timeZone: 'America/Phoenix', month: 'numeric', day: 'numeric' }),
      rawDate: new Date(r.start_time).toLocaleDateString('en-US', { timeZone: 'America/Phoenix' }),
    }))))
    fetchAccelerationRuns().then(setRuns).catch(() => {})
    fetchTelemetryTopSpeed().then(d => setTelTopSpeed(d.top_speed || null)).catch(() => {})
    fetchMonthlyDrives().then(setMonthly).catch(() => {})
    fetchDestinations().then(setDestinations).catch(() => {})
    fetchSpeedHistogram().then(setSpeedBands).catch(() => {})
  }, [])

  const filteredEfficiency = (() => {
    if (effPeriod === 'All') return efficiency
    // Parse current date components in AZ time
    const azStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' })
    const [azM, azD, azY] = azStr.split('/').map(Number)
    // AZ midnight = UTC offset +7h
    const azMidnight = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 7, 0, 0))
    const cutoffs = {
      YTD:   azMidnight(azY, 1, 1),
      Month: azMidnight(azY, azM, 1),
      Week:  azMidnight(azY, azM, azD - new Date().getDay()),
      Day:   azMidnight(azY, azM, azD),
    }
    const cutoff = cutoffs[effPeriod]
    return efficiency.filter(r => new Date(r.start_time) >= cutoff)
  })()

  const totalMiles = Math.round(drives.reduce((a, d) => a + (d.distance_miles || 0), 0))
  const avgEfficiency = filteredEfficiency.length
    ? Math.round(filteredEfficiency.reduce((a, e) => a + e.wh_per_mile, 0) / filteredEfficiency.length)
    : null
  const topSpeed = drives.reduce((a, d) => Math.max(a, d.max_speed || 0), 0)

  return (
    <div>
      <DriveMap />

      <div className="stat-grid">
        <div className="stat"><div className="val accent">{drives.length}</div><div className="lbl">Drives Recorded</div></div>
        <div className="stat"><div className="val">{totalMiles.toLocaleString()}</div><div className="lbl">Total Miles</div></div>
        <div className="stat"><div className="val">{avgEfficiency ?? '—'}</div><div className="lbl">Avg Wh/mi</div></div>
        <div className="stat"><div className="val">{(telTopSpeed ?? topSpeed) || '—'}</div><div className="lbl">Top Speed{telTopSpeed ? ' ⚡' : ''} (mph)</div></div>
      </div>

      {/* Monthly summary */}
      {monthly.length > 1 && (
        <div className="card">
          <h2>Monthly Miles</h2>
          <p className="card-note">Distance driven per calendar month</p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={monthly} margin={{ right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="0" stroke="#1a1a1a" vertical={false} />
              <XAxis dataKey="month" tickFormatter={v => v.slice(5)} tick={{ fill: '#555', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#555', fontSize: 10 }} unit=" mi" axisLine={false} tickLine={false} width={48} />
              <Tooltip {...TT} formatter={(v, k) => [k === 'miles' ? `${v} mi` : `${v} trips`, k === 'miles' ? 'Miles' : 'Drives']} />
              <Bar dataKey="miles" fill="#38bdf8" radius={[2, 2, 0, 0]} maxBarSize={32} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Speed histogram + destination map side by side */}
      {(speedBands.length > 0 || destinations.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          {speedBands.length > 0 && (
            <div className="card">
              <h2>Speed Profile</h2>
              <p className="card-note">% of driving-time snapshots in each speed band</p>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={speedBands} layout="vertical" margin={{ right: 40, left: 0, top: 4, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="0" stroke="#1a1a1a" horizontal={false} />
                  <XAxis type="number" tick={{ fill: '#555', fontSize: 10 }} unit="%" axisLine={false} tickLine={false} domain={[0, 100]} />
                  <YAxis type="category" dataKey="label" tick={{ fill: '#888', fontSize: 10 }} axisLine={false} tickLine={false} width={36} />
                  <Tooltip {...TT} formatter={v => [`${v}%`, 'Time']} />
                  <Bar dataKey="pct" radius={[0, 2, 2, 0]} maxBarSize={22}>
                    {speedBands.map((b, i) => {
                      const colors = ['#ef4444', '#f97316', '#38bdf8', '#22c55e', '#a855f7']
                      return <Cell key={i} fill={colors[i] || '#38bdf8'} />
                    })}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {destinations.length > 0 && (() => {
            const lats = destinations.map(d => d.lat)
            const lons = destinations.map(d => d.lon)
            const center = [
              (Math.min(...lats) + Math.max(...lats)) / 2,
              (Math.min(...lons) + Math.max(...lons)) / 2,
            ]
            const maxCount = destinations[0].count
            return (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)' }}>
                  <h2 style={{ margin: 0 }}>Top Destinations</h2>
                  <p className="card-note" style={{ margin: '0.2rem 0 0' }}>Clustered drive endpoints · bigger = more visits</p>
                </div>
                <div style={{ height: 260 }}>
                  <MapContainer center={center} zoom={11}
                    style={{ height: '100%', width: '100%', background: '#080808' }}
                    zoomControl attributionControl={false}>
                    <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" subdomains="abcd" maxZoom={19} />
                    {destinations.slice(0, 15).map((d, i) => {
                      const r = 5 + Math.round((d.count / maxCount) * 12)
                      return (
                        <CircleMarker key={i} center={[d.lat, d.lon]} radius={r}
                          pathOptions={{ color: '#38bdf8', fillColor: '#38bdf8', fillOpacity: 0.7, weight: 1.5 }}>
                          <Popup>
                            <div style={{ fontSize: '0.75rem', lineHeight: 1.6 }}>
                              <strong>#{i + 1}</strong><br />
                              {d.count} visits<br />
                              Last: {d.last_visit ? d.last_visit.slice(0, 10) : '—'}
                            </div>
                          </Popup>
                        </CircleMarker>
                      )
                    })}
                  </MapContainer>
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {efficiency.length > 1 && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
            <h2 style={{ margin: 0 }}>Efficiency Over Time</h2>
            <div style={{ display: 'flex', gap: '0.3rem' }}>
              {['All', 'YTD', 'Month', 'Week', 'Day'].map(p => (
                <button
                  key={p}
                  onClick={() => setEffPeriod(p)}
                  style={{
                    padding: '0.2rem 0.5rem', fontSize: '0.7rem', cursor: 'pointer',
                    background: effPeriod === p ? 'var(--accent)' : 'var(--surface-2)',
                    color: effPeriod === p ? '#000' : 'var(--text-3)',
                    border: '1px solid var(--border)', borderRadius: 3,
                  }}
                >{p}</button>
              ))}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={filteredEfficiency} margin={{ right: 75 }}>
              <CartesianGrid strokeDasharray="0" stroke="#1a1a1a" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: '#555', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#555', fontSize: 10 }} unit=" Wh" axisLine={false} tickLine={false} width={45} />
              <Tooltip {...TT} />
              <ReferenceLine y={239} stroke="#444" strokeWidth={1}
                label={{ value: 'EPA 239', fill: '#666', fontSize: 10, position: 'insideTop', dy: -12 }} />
              {avgEfficiency && (
                <ReferenceLine y={avgEfficiency} stroke="#38bdf8" strokeDasharray="4 4"
                  label={{ value: `Avg ${avgEfficiency}`, fill: '#38bdf8', fontSize: 10, position: 'right' }} />
              )}
              <Line type="monotone" dataKey="wh_per_mile" stroke="#ff6b2b"
                strokeWidth={2} dot={false} activeDot={{ r: 3, fill: '#ff6b2b' }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {drives.length > 0 && (
        <div className="card">
          <h2>Drive Log</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date / Time</th><th>Distance</th><th>Duration</th>
                  <th>Max Speed</th><th>Start %</th><th>End %</th><th>Energy</th>
                </tr>
              </thead>
              <tbody>
                {drives.map((d, i) => (
                  <tr key={i}>
                    <td style={{ color: 'var(--text)' }}>{fmtDateTime(d.start_time)}</td>
                    <td>{d.distance_miles ? `${d.distance_miles.toFixed(1)} mi` : '—'}</td>
                    <td>{fmtDuration(d.duration_seconds)}</td>
                    <td>{d.max_speed ? `${d.max_speed} mph` : '—'}</td>
                    <td>{d.start_soc ? `${d.start_soc}%` : '—'}</td>
                    <td style={{ color: d.end_soc < d.start_soc ? 'var(--red)' : 'var(--text-2)' }}>
                      {d.end_soc ? `${d.end_soc}%` : '—'}
                    </td>
                    <td>{d.energy_used_kwh ? `${d.energy_used_kwh.toFixed(1)} kWh` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <h2>Top Acceleration Runs</h2>
        <p style={{ color: 'var(--text-2)', fontSize: '0.75rem', margin: '-0.5rem 0 1rem' }}>±0.5s accuracy · 1 Hz telemetry · fastest 0–60 first</p>
        {runs.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Date</th><th>0–60 mph</th><th>0–100 mph</th><th>Top Speed</th></tr>
              </thead>
              <tbody>
                {runs.slice(0, 5).map((r, i) => (
                  <tr key={i}>
                    <td style={{ color: 'var(--text)' }}>{fmtDate(r.ts)}</td>
                    <td style={{ color: 'var(--accent)' }}>{r.time_0_to_60}s</td>
                    <td>{r.time_0_to_100 ? `${r.time_0_to_100}s` : '—'}</td>
                    <td>{r.max_speed ? `${r.max_speed} mph` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">No runs recorded yet — floor it to generate data. Requires telemetry setup.</p>
        )}
      </div>

      {!drives.length && <p className="empty">No drives recorded yet — data builds up as you drive.</p>}
    </div>
  )
}
