import React, { useEffect, useState, useRef, useCallback } from 'react'
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { fetchStops, deleteStopCluster } from '../api'
import { fmtDateTime } from '../fmt'

const fmtWait = s => s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`

function CycleBadge({ cycle }) {
  if (!cycle) return <span style={{ color: 'var(--text-3)', fontSize: '0.65rem' }}>—</span>
  if (cycle.status === 'building') return (
    <span style={{ color: 'var(--text-3)', fontSize: '0.65rem' }}>
      Building ({cycle.have}/{cycle.need})
    </span>
  )
  if (cycle.status === 'no_pattern') return (
    <span style={{ color: 'var(--text-3)', fontSize: '0.65rem' }}>No pattern yet</span>
  )
  return (
    <span style={{ color: 'var(--accent)', fontSize: '0.65rem', fontWeight: 700 }}>
      ~{cycle.cycle_seconds}s cycle · {cycle.confidence}% conf
    </span>
  )
}

function stopColor(avgWait, maxWait) {
  const t = Math.min(avgWait / Math.max(maxWait, 30), 1)
  const r = Math.round(0x38 + t * (0xff - 0x38))
  const g = Math.round(0xbd - t * (0xbd - 0x1a))
  const b = Math.round(0xf8 - t * (0xf8 - 0x1a))
  return `rgb(${r},${g},${b})`
}

function MapController({ closePopupsTrigger, flyTo, onReady }) {
  const map = useMap()
  useEffect(() => { onReady(map) }, [map])
  useEffect(() => { if (closePopupsTrigger) map.closePopup() }, [closePopupsTrigger])
  useEffect(() => { if (flyTo) map.flyTo(flyTo, 17, { duration: 0.8 }) }, [flyTo])
  return null
}

export default function StopAnalysis() {
  const [stops, setStops] = useState([])
  const [deleting, setDeleting] = useState(null)
  const [confirmKey, setConfirmKey] = useState(null)
  const [closePopups, setClosePopups] = useState(0)
  const [tableConfirm, setTableConfirm] = useState(null)
  const [flyTo, setFlyTo] = useState(null)

  const load = () => fetchStops().then(setStops)
  useEffect(() => { load() }, [])

  const handleDelete = async (lat, lon) => {
    const key = `${lat},${lon}`
    setDeleting(key)
    setConfirmKey(null)
    setTableConfirm(null)
    try {
      await deleteStopCluster(lat, lon)
      setClosePopups(n => n + 1)
      await load()
    } catch {}
    setDeleting(null)
  }

  if (!stops.length) return (
    <p className="empty">
      No stop data yet.<br />
      Traffic light stops (8–180s) are logged automatically during live polling.<br />
      Data builds up after a few drives.
    </p>
  )

  const totalStops = stops.reduce((a, s) => a + s.count, 0)
  const totalWait = stops.reduce((a, s) => a + s.total_duration, 0)
  const worstAvg = stops.reduce((a, s) => Math.max(a, s.avg_wait_seconds), 0)

  const lats = stops.map(s => s.lat)
  const lons = stops.map(s => s.lon)
  const center = [
    (Math.min(...lats) + Math.max(...lats)) / 2,
    (Math.min(...lons) + Math.max(...lons)) / 2,
  ]

  return (
    <div>
      <div className="stat-grid">
        <div className="stat"><div className="val accent">{stops.length}</div><div className="lbl">Intersections</div></div>
        <div className="stat"><div className="val">{totalStops}</div><div className="lbl">Total Stops</div></div>
        <div className="stat"><div className="val red">{fmtWait(totalWait)}</div><div className="lbl">Total Time Lost</div></div>
        <div className="stat"><div className="val">{fmtWait(worstAvg)}</div><div className="lbl">Worst Avg Wait</div></div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)' }}>
          <h2 style={{ margin: 0 }}>Stop Locations</h2>
          <p className="card-note" style={{ margin: '0.2rem 0 0' }}>Blue = short wait · red = long wait · click a dot to remove</p>
        </div>
        <div style={{ height: 360 }}>
          <MapContainer center={center} zoom={13} style={{ height: '100%', width: '100%' }} zoomControl attributionControl={false}>
            <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" subdomains="abcd" maxZoom={19} />
            <MapController closePopupsTrigger={closePopups} flyTo={flyTo} onReady={() => {}} />
            {stops.map((s, i) => {
              const color = stopColor(s.avg_wait_seconds, worstAvg)
              const key = `${s.lat},${s.lon}`
              const isConfirming = confirmKey === key
              return (
                <CircleMarker
                  key={key}
                  center={[s.lat, s.lon]}
                  radius={7}
                  pathOptions={{ color, fillColor: color, fillOpacity: 0.85, weight: 1.5 }}
                >
                  <Popup onClose={() => setConfirmKey(null)}>
                    <div style={{ fontSize: '0.75rem', lineHeight: 1.7, minWidth: 165 }}>
                      <strong>#{i + 1}</strong><br />
                      {s.count}× stopped · avg {fmtWait(s.avg_wait_seconds)}<br />
                      Last: {fmtDateTime(s.last_seen)}<br />
                      {s.cycle?.status === 'detected' && (
                        <span style={{ color: '#38bdf8' }}>
                          ~{s.cycle.cycle_seconds}s cycle · ~{s.cycle.red_phase_seconds}s red · {s.cycle.confidence}% conf<br />
                        </span>
                      )}
                      {s.cycle?.status === 'building' && (
                        <span style={{ color: '#888' }}>
                          Cycle: need {s.cycle.need - s.cycle.have} more stops<br />
                        </span>
                      )}
                      {!isConfirming ? (
                        <button
                          onClick={() => setConfirmKey(key)}
                          style={{ marginTop: 6, background: 'none', border: '1px solid #e55', cursor: 'pointer', color: '#e55', fontSize: '0.72rem', padding: '2px 8px', width: '100%' }}
                        >Remove Stop</button>
                      ) : (
                        <div style={{ marginTop: 6, display: 'flex', gap: 4 }}>
                          <button
                            onClick={() => handleDelete(s.lat, s.lon)}
                            disabled={deleting === key}
                            style={{ flex: 1, background: '#e55', border: 'none', cursor: 'pointer', color: '#fff', fontSize: '0.72rem', padding: '3px 0' }}
                          >{deleting === key ? '…' : 'Yes, remove'}</button>
                          <button
                            onClick={() => setConfirmKey(null)}
                            style={{ flex: 1, background: 'none', border: '1px solid #555', cursor: 'pointer', color: '#999', fontSize: '0.72rem', padding: '3px 0' }}
                          >Cancel</button>
                        </div>
                      )}
                    </div>
                  </Popup>
                </CircleMarker>
              )
            })}
          </MapContainer>
        </div>
      </div>

      <div className="card">
        <h2>Stop Log</h2>
        <p className="card-note">Clustered within 0.03 mi · sorted by frequency</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>#</th><th>Last Seen</th><th>Coordinates</th><th>Times</th><th>Avg Wait</th><th>Cycle</th><th>Total</th><th></th></tr>
            </thead>
            <tbody>
              {stops.map((s, i) => {
                const key = `${s.lat},${s.lon}`
                const isConfirming = tableConfirm === key
                return (
                  <tr key={key} onClick={() => setFlyTo([s.lat, s.lon])} style={{ cursor: 'pointer' }}>
                    <td><span className={`badge ${i === 0 ? 'badge-1' : i < 3 ? 'badge-top' : 'badge-gray'}`}>#{i + 1}</span></td>
                    <td style={{ color: 'var(--text-2)', whiteSpace: 'nowrap' }}>{fmtDateTime(s.last_seen)}</td>
                    <td style={{ color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' }}>{s.lat.toFixed(5)}, {s.lon.toFixed(5)}</td>
                    <td style={{ fontWeight: 700, color: i < 3 ? 'var(--accent)' : 'var(--text)' }}>{s.count}×</td>
                    <td>{fmtWait(s.avg_wait_seconds)}</td>
                    <td><CycleBadge cycle={s.cycle} /></td>
                    <td style={{ color: 'var(--red)' }}>{fmtWait(s.total_duration)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {!isConfirming ? (
                        <button
                          onClick={e => { e.stopPropagation(); setTableConfirm(key) }}
                          className="refresh-btn"
                          style={{ padding: '0.2rem 0.5rem', fontSize: '0.65rem', color: 'var(--red)', borderColor: 'var(--red)' }}
                        >Remove</button>
                      ) : (
                        <div style={{ display: 'flex', gap: '0.3rem' }} onClick={e => e.stopPropagation()}>
                          <button
                            onClick={() => handleDelete(s.lat, s.lon)}
                            disabled={deleting === key}
                            className="refresh-btn"
                            style={{ padding: '0.2rem 0.5rem', fontSize: '0.65rem', background: 'var(--red)', color: '#fff', borderColor: 'var(--red)' }}
                          >{deleting === key ? '…' : 'Confirm'}</button>
                          <button
                            onClick={() => setTableConfirm(null)}
                            className="refresh-btn"
                            style={{ padding: '0.2rem 0.5rem', fontSize: '0.65rem' }}
                          >Cancel</button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
