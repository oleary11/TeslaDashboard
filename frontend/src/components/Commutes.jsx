import React, { useEffect, useState } from 'react'
import { MapContainer, TileLayer, Polyline, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import {
  LineChart, Line, BarChart, Bar,
  ScatterChart, Scatter,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  Cell,
} from 'recharts'
import { fetchCommutes, fetchDriveTrack, fetchOptimalDeparture } from '../api'
import { fmtDate, fmtTime } from '../fmt'

const fmtDur = s => {
  if (!s && s !== 0) return '—'
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

// 0 mph = red, max mph = green
const speedColor = (speed, maxSpeed) => {
  if (speed === null || speed === undefined || speed === 0) return '#ef4444'
  const t = Math.min(speed / Math.max(maxSpeed, 1), 1)
  const r = Math.round(239 + t * (34 - 239))
  const g = Math.round(68 + t * (197 - 68))
  const b = Math.round(68 + t * (94 - 68))
  return `rgb(${r},${g},${b})`
}

function AutoFit({ points }) {
  const map = useMap()
  useEffect(() => {
    if (!points.length) return
    const lats = points.map(p => p.lat)
    const lons = points.map(p => p.lon)
    map.fitBounds([
      [Math.min(...lats), Math.min(...lons)],
      [Math.max(...lats), Math.max(...lons)],
    ], { padding: [28, 28] })
  }, [points, map])
  return null
}

function SpeedMap({ driveId }) {
  const [track, setTrack] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!driveId) return
    setLoading(true)
    fetchDriveTrack(driveId).then(d => { setTrack(d); setLoading(false) })
  }, [driveId])

  const header = (
    <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
      <div>
        <h2 style={{ margin: 0 }}>Most Recent Route</h2>
        <p className="card-note" style={{ margin: '0.2rem 0 0' }}>Green = faster · Red = slower / stopped</p>
      </div>
    </div>
  )

  if (loading) return <div className="card" style={{ padding: 0, overflow: 'hidden' }}>{header}<p className="empty" style={{ padding: '2rem 1rem' }}>Loading track…</p></div>
  if (!track || !track.points || track.points.length < 2) return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {header}
      <p className="empty" style={{ padding: '2rem 1rem' }}>No GPS track for this drive</p>
    </div>
  )

  const maxSpeed = Math.max(...track.points.map(p => p.speed || 0))
  const segments = []
  for (let i = 0; i + 1 < track.points.length; i++) {
    const a = track.points[i], b = track.points[i + 1]
    segments.push({
      positions: [[a.lat, a.lon], [b.lat, b.lon]],
      color: speedColor(a.speed, maxSpeed),
    })
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <h2 style={{ margin: 0 }}>Most Recent Route</h2>
          <p className="card-note" style={{ margin: '0.2rem 0 0' }}>Green = faster · Red = slower / stopped</p>
        </div>
        <span style={{ fontSize: '0.65rem', color: 'var(--text-3)' }}>Top speed: {maxSpeed} mph</span>
      </div>
      <div style={{ height: 340, position: 'relative' }}>
        <MapContainer
          center={[track.points[0].lat, track.points[0].lon]}
          zoom={12}
          style={{ height: '100%', width: '100%', background: '#080808' }}
          zoomControl
          attributionControl={false}
        >
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            subdomains="abcd"
            maxZoom={19}
          />
          {segments.map((seg, i) => (
            <Polyline
              key={i}
              positions={seg.positions}
              pathOptions={{ color: seg.color, weight: 4, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }}
            />
          ))}
          <AutoFit points={track.points} />
        </MapContainer>
        <div style={{
          position: 'absolute', bottom: 12, right: 12, zIndex: 1000,
          background: 'rgba(8,8,8,0.88)', border: '1px solid var(--border)',
          padding: '0.5rem 0.75rem', fontSize: '0.6rem', color: 'var(--text-3)',
          letterSpacing: '0.05em', textTransform: 'uppercase',
        }}>
          <div style={{ marginBottom: '0.35rem' }}>Speed</div>
          <div style={{ width: 100, height: 6, background: 'linear-gradient(to right, #ef4444, #22c55e)', marginBottom: '0.3rem' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', width: 100 }}>
            <span>Stopped</span><span>{maxSpeed} mph</span>
          </div>
        </div>
      </div>
    </div>
  )
}

const tooltipStyle = { background: 'var(--surface-2)', border: '1px solid var(--border)', fontSize: '0.7rem', color: 'var(--text)' }
const tickStyle = { fontSize: 9, fill: 'var(--text-3)' }

export default function Commutes() {
  const [data, setData] = useState(null)
  const [dir, setDir] = useState('to_work')
  const [optimal, setOptimal] = useState(null)

  useEffect(() => { fetchCommutes().then(setData) }, [])
  useEffect(() => {
    setOptimal(null)
    fetchOptimalDeparture(dir).then(setOptimal).catch(() => {})
  }, [dir])

  if (!data) return <p className="empty">Loading…</p>

  const list = data[dir] || []
  const fastest = list[0]
  const slowest = list[list.length - 1]
  const avg = list.length
    ? Math.round(list.reduce((a, d) => a + (d.duration_seconds || 0), 0) / list.length)
    : 0

  const mostRecent = list.length
    ? list.reduce((best, d) => (!best || (d.start_time || '') > (best.start_time || '')) ? d : best, null)
    : null

  const chartData = [...list]
    .sort((a, b) => (a.start_time || '') < (b.start_time || '') ? -1 : 1)
    .map(d => ({
      date: (d.start_time || '').slice(5, 10),
      duration: +((d.duration_seconds || 0) / 60).toFixed(1),
      stoplights: +((d.stoplight_seconds || 0) / 60).toFixed(1),
    }))

  return (
    <div>
      <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '1rem' }}>
        {[['to_work', '→ Work'], ['to_home', '← Home']].map(([val, label]) => (
          <button key={val} onClick={() => setDir(val)} style={{
            background: dir === val ? 'var(--accent)' : 'var(--surface)',
            color: dir === val ? '#000' : 'var(--text-3)',
            border: `1px solid ${dir === val ? 'var(--accent)' : 'var(--border)'}`,
            padding: '0.35rem 0.9rem', cursor: 'pointer',
            fontSize: '0.65rem', fontWeight: 700,
            letterSpacing: '0.08em', textTransform: 'uppercase',
          }}>
            {label}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <p className="empty">
          No {dir === 'to_work' ? 'work' : 'home'} commutes recorded yet.<br />
          Commutes are detected automatically as you drive between home and work.
        </p>
      ) : (
        <>
          {/* Most Recent */}
          {mostRecent && (
            <div className="card" style={{ marginBottom: '1rem', borderLeft: '3px solid var(--accent)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.75rem' }}>
                <h2 style={{ margin: 0 }}>Most Recent</h2>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-3)' }}>
                  {fmtDate(mostRecent.start_time)} · {fmtTime(mostRecent.start_time)} → {fmtTime(mostRecent.end_time)}
                </span>
              </div>
              <div className="stat-grid">
                <div className="stat">
                  <div className="val">{fmtDur(mostRecent.duration_seconds)}</div>
                  <div className="lbl">Duration</div>
                </div>
                <div className="stat">
                  <div className="val">{mostRecent.distance_miles ? `${mostRecent.distance_miles.toFixed(1)} mi` : '—'}</div>
                  <div className="lbl">Distance</div>
                </div>
                <div className="stat">
                  <div className="val red">{mostRecent.stoplight_seconds > 0 ? fmtDur(mostRecent.stoplight_seconds) : '—'}</div>
                  <div className="lbl">Red Lights</div>
                </div>
                <div className="stat">
                  <div className="val green">
                    {mostRecent.stoplight_seconds > 0
                      ? fmtDur((mostRecent.duration_seconds || 0) - (mostRecent.stoplight_seconds || 0))
                      : '—'}
                  </div>
                  <div className="lbl">Drive Time</div>
                </div>
              </div>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-3)', marginTop: '0.6rem' }}>
                Ranked #{mostRecent.rank} of {list.length} commutes
              </div>
            </div>
          )}

          {/* Overall stats */}
          <div className="stat-grid" style={{ marginBottom: '1rem' }}>
            <div className="stat"><div className="val accent">{list.length}</div><div className="lbl">Commutes</div></div>
            <div className="stat"><div className="val green">{fmtDur(fastest?.duration_seconds)}</div><div className="lbl">Fastest</div></div>
            <div className="stat"><div className="val red">{fmtDur(slowest?.duration_seconds)}</div><div className="lbl">Slowest</div></div>
            <div className="stat"><div className="val">{fmtDur(avg)}</div><div className="lbl">Average</div></div>
          </div>

          {/* Speed-colored route map */}
          {mostRecent && (
            <div style={{ marginBottom: '1rem' }}>
              <SpeedMap driveId={mostRecent.id} />
            </div>
          )}

          {/* Optimal departure */}
          {optimal && (
            <div className="card" style={{ marginBottom: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.75rem' }}>
                <h2 style={{ margin: 0 }}>Optimal Departure Time</h2>
                {optimal.has_data && (
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-3)' }}>
                    {optimal.lights_with_cycles} of {optimal.total_lights_on_route} lights analyzed · {optimal.scan_window_start}–{optimal.scan_window_end}
                  </span>
                )}
              </div>

              {!optimal.has_data ? (
                <div>
                  {optimal.reason === 'no_commutes' ? (
                    <p className="empty" style={{ padding: '0.5rem 0' }}>No commutes recorded yet.</p>
                  ) : optimal.reason === 'no_stops_on_commutes' ? (
                    <p className="empty" style={{ padding: '0.5rem 0' }}>
                      No stoplight stops detected on this commute yet — data builds up as you drive.
                    </p>
                  ) : (
                    <div>
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-2)', margin: '0 0 0.75rem' }}>
                        Tracking {optimal.total_lights_on_route ?? 0} stoplight{optimal.total_lights_on_route !== 1 ? 's' : ''} on your commute.
                        {optimal.stops_still_needed != null && ` Need ${optimal.stops_still_needed} more stop${optimal.stops_still_needed !== 1 ? 's' : ''} to establish cycle patterns.`}
                      </p>
                      {optimal.building_lights > 0 && (
                        <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', padding: '0.6rem 0.85rem', fontSize: '0.7rem', color: 'var(--text-3)' }}>
                          Each new commute adds data. Recommendations appear automatically once patterns are statistically significant (min 8 stops per direction per intersection).
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                  <div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--green)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                      Best Windows
                    </div>
                    {optimal.best_windows.map((w, i) => (
                      <div key={i} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '0.4rem 0', borderBottom: '1px solid var(--border)',
                      }}>
                        <span style={{ fontSize: '1rem', fontWeight: 700, color: i === 0 ? 'var(--green)' : 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
                          {w.depart_time}
                        </span>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-3)' }}>
                          {w.expected_wait_seconds === 0
                            ? 'No red lights'
                            : `~${Math.round(w.expected_wait_seconds)}s wait · ${w.lights_hit} light${w.lights_hit !== 1 ? 's' : ''}`}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--red)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                      Worst Windows (avoid)
                    </div>
                    {optimal.worst_windows.map((w, i) => (
                      <div key={i} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '0.4rem 0', borderBottom: '1px solid var(--border)',
                      }}>
                        <span style={{ fontSize: '1rem', fontWeight: 700, color: i === 0 ? 'var(--red)' : 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
                          {w.depart_time}
                        </span>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-3)' }}>
                          ~{Math.round(w.expected_wait_seconds)}s wait · {w.lights_hit} light{w.lights_hit !== 1 ? 's' : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Charts row 1: trend + red lights */}
          {chartData.length >= 2 && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
              <div className="card">
                <h2>Duration Trend</h2>
                <p className="card-note">Commute time per trip (minutes)</p>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="date" tick={tickStyle} />
                    <YAxis tick={tickStyle} unit="m" />
                    <Tooltip contentStyle={tooltipStyle} formatter={v => [`${v}m`, 'Duration']} />
                    <Line type="monotone" dataKey="duration" stroke="var(--accent)" dot={{ r: 3 }} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="card">
                <h2>Red Light Time</h2>
                <p className="card-note">Minutes stopped at lights per trip</p>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="date" tick={tickStyle} />
                    <YAxis tick={tickStyle} unit="m" />
                    <Tooltip contentStyle={tooltipStyle} formatter={v => [`${v}m`, 'Red lights']} />
                    <Bar dataKey="stoplights" fill="#ef4444" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Charts row 2: day of week + departure sweet spot */}
          {list.length >= 3 && (() => {
            const AZ = 'America/Phoenix'
            const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
            const byDow = {}
            list.forEach(d => {
              // Use Phoenix timezone so midnight drives don't land on the wrong day
              const dayStr = new Date(d.start_time).toLocaleDateString('en-US', { timeZone: AZ, weekday: 'short' })
              if (!byDow[dayStr]) byDow[dayStr] = []
              byDow[dayStr].push(d.duration_seconds / 60)
            })
            const dowData = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
              .filter(d => byDow[d])
              .map(d => ({
                day: d,
                avg: +(byDow[d].reduce((a, v) => a + v, 0) / byDow[d].length).toFixed(1),
                count: byDow[d].length,
              }))

            // Departure sweet spot: x = minutes since midnight, y = duration min
            const departData = list.map(d => {
              const dt = new Date(d.start_time)
              const timeStr = dt.toLocaleTimeString('en-US', { timeZone: AZ, hour: '2-digit', minute: '2-digit', hour12: false })
              const [hh, mm] = timeStr.split(':').map(Number)
              return { x: hh * 60 + mm, y: +(d.duration_seconds / 60).toFixed(1), date: fmtDate(d.start_time) }
            })
            const minX = Math.min(...departData.map(d => d.x))
            const maxX = Math.max(...departData.map(d => d.x))
            const tickCount = Math.min(6, Math.ceil((maxX - minX) / 15) + 1)
            const xTicks = Array.from({ length: tickCount }, (_, i) =>
              Math.round(minX + (i / (tickCount - 1)) * (maxX - minX))
            )
            const fmtMin = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`

            return (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div className="card">
                  <h2>By Day of Week</h2>
                  <p className="card-note">Avg commute duration · number = trips recorded</p>
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={dowData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="day" tick={tickStyle} />
                      <YAxis tick={tickStyle} unit="m" />
                      <Tooltip contentStyle={tooltipStyle}
                        formatter={(v, _, p) => [`${v}m avg · ${p.payload.count} trips`, p.payload.day]} />
                      <Bar dataKey="avg" radius={[2, 2, 0, 0]}>
                        {dowData.map((d, i) => (
                          <Cell key={i} fill={d.day === 'Mon' || d.day === 'Fri' ? '#f97316' : 'var(--accent)'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="card">
                  <h2>Departure Sweet Spot</h2>
                  <p className="card-note">Leave time vs total duration — look for the low cluster</p>
                  <ResponsiveContainer width="100%" height={180}>
                    <ScatterChart margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis type="number" dataKey="x" domain={[minX - 5, maxX + 5]}
                        ticks={xTicks} tickFormatter={fmtMin} tick={tickStyle} />
                      <YAxis type="number" dataKey="y" tick={tickStyle} unit="m" />
                      <Tooltip contentStyle={tooltipStyle}
                        formatter={(v, name) => [name === 'x' ? fmtMin(v) : `${v}m`, name === 'x' ? 'Depart' : 'Duration']} />
                      <Scatter data={departData} fill="var(--accent)" opacity={0.75} r={4} />
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )
          })()}

          {/* Rankings table */}
          <div className="card">
            <h2>Rankings</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Rank</th><th>Date</th><th>Duration</th><th>Distance</th>
                    <th>Stoplights</th><th>Optimal</th><th>Depart</th><th>Arrive</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((d, i) => {
                    const stoplight = d.stoplight_seconds || 0
                    const optimal = (d.duration_seconds || 0) - stoplight
                    return (
                      <tr key={i}>
                        <td>
                          <span className={`badge ${i === 0 ? 'badge-1' : i < 3 ? 'badge-top' : 'badge-gray'}`}>
                            #{d.rank}
                          </span>
                        </td>
                        <td style={{ color: 'var(--text)' }}>{fmtDate(d.start_time)}</td>
                        <td style={{
                          fontWeight: 700,
                          color: i === 0 ? 'var(--green)' : i === list.length - 1 ? 'var(--red)' : 'var(--text)',
                        }}>
                          {fmtDur(d.duration_seconds)}
                        </td>
                        <td>{d.distance_miles ? `${d.distance_miles.toFixed(1)} mi` : '—'}</td>
                        <td style={{ color: 'var(--red)' }}>{stoplight > 0 ? fmtDur(stoplight) : '—'}</td>
                        <td style={{ color: 'var(--green)' }}>{stoplight > 0 ? fmtDur(optimal) : '—'}</td>
                        <td>{fmtTime(d.start_time)}</td>
                        <td>{fmtTime(d.end_time)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
