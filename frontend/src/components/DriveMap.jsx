import React, { useEffect, useState, useMemo } from 'react'
import { MapContainer, TileLayer, Polyline, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { fetchTracks } from '../api'

// Snap lat/lon to ~10m grid cell for frequency counting
const cellKey = (lat, lon) =>
  `${Math.round(lat * 5000)},${Math.round(lon * 5000)}`

function buildFreqMap(tracks) {
  const freq = {}
  for (const t of tracks) {
    const visited = new Set()
    for (const [lat, lon] of t.points) {
      const k = cellKey(lat, lon)
      if (!visited.has(k)) {
        visited.add(k)
        freq[k] = (freq[k] || 0) + 1
      }
    }
  }
  return freq
}

function trackScore(points, freqMap) {
  if (!points.length) return 1
  let sum = 0
  for (const [lat, lon] of points) sum += freqMap[cellKey(lat, lon)] || 1
  return sum / points.length
}

// score → color along blue→orange→red gradient
function scoreColor(score, maxScore) {
  const t = Math.min(score / Math.max(maxScore, 6), 1)
  if (t < 0.5) {
    // blue (#38bdf8) → orange (#ff6b2b)
    const u = t * 2
    const r = Math.round(0x38 + u * (0xff - 0x38))
    const g = Math.round(0xbd - u * (0xbd - 0x6b))
    const b = Math.round(0xf8 - u * (0xf8 - 0x2b))
    return `rgb(${r},${g},${b})`
  } else {
    // orange (#ff6b2b) → red (#ff1a1a)
    const u = (t - 0.5) * 2
    const r = 0xff
    const g = Math.round(0x6b - u * 0x6b)
    const b = Math.round(0x2b - u * 0x2b)
    return `rgb(${r},${g},${b})`
  }
}

function AutoFit({ tracks }) {
  const map = useMap()
  useEffect(() => {
    if (!tracks.length) return
    const all = tracks.flatMap(t => t.points)
    if (!all.length) return
    const lats = all.map(p => p[0])
    const lons = all.map(p => p[1])
    map.fitBounds([
      [Math.min(...lats), Math.min(...lons)],
      [Math.max(...lats), Math.max(...lons)],
    ], { padding: [32, 32] })
  }, [tracks, map])
  return null
}

export default function DriveMap() {
  const [tracks, setTracks] = useState([])
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetchTracks(start, end).then(data => {
      setTracks(Array.isArray(data) ? data : [])
      setLoading(false)
    })
  }, [start, end])

  const { colored, maxScore } = useMemo(() => {
    if (!tracks.length) return { colored: [], maxScore: 1 }
    const freqMap = buildFreqMap(tracks)
    const scored = tracks.map(t => ({ ...t, score: trackScore(t.points, freqMap) }))
    const max = Math.max(...scored.map(t => t.score))
    return {
      colored: scored.map(t => ({ ...t, color: scoreColor(t.score, max) })),
      maxScore: max,
    }
  }, [tracks])

  const inputStyle = {
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    padding: '0.3rem 0.6rem',
    fontSize: '0.7rem',
    fontFamily: 'inherit',
    outline: 'none',
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)',
      }}>
        <div>
          <h2 style={{ margin: 0 }}>Drive Paths</h2>
          <p className="card-note" style={{ margin: '0.2rem 0 0' }}>
            {loading ? 'Loading…' : `${tracks.length} drives · blue → orange → red = frequency`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <span style={{ fontSize: '0.65rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>From</span>
          <input type="date" value={start} onChange={e => setStart(e.target.value)} style={inputStyle} />
          <span style={{ fontSize: '0.65rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>To</span>
          <input type="date" value={end} onChange={e => setEnd(e.target.value)} style={inputStyle} />
          {(start || end) && (
            <button onClick={() => { setStart(''); setEnd('') }} style={{
              ...inputStyle, cursor: 'pointer', color: 'var(--accent)',
              border: '1px solid var(--accent)', padding: '0.3rem 0.6rem',
            }}>Clear</button>
          )}
        </div>
      </div>

      {!loading && !tracks.length ? (
        <p className="empty" style={{ padding: '3rem 1rem' }}>
          No drive GPS tracks yet.<br />
          Tracks are recorded automatically during live polling while driving.
        </p>
      ) : (
        <div style={{ height: 420, position: 'relative' }}>
          <MapContainer
            center={[33.45, -111.94]}
            zoom={11}
            style={{ height: '100%', width: '100%', background: '#080808' }}
            zoomControl={true}
            attributionControl={false}
          >
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              attribution='&copy; <a href="https://carto.com/">CARTO</a>'
              subdomains="abcd"
              maxZoom={19}
            />
            {colored.map(t => (
              <Polyline
                key={t.id}
                positions={t.points}
                pathOptions={{
                  color: t.color,
                  weight: Math.max(1.5, Math.min(4, 1 + t.score * 0.5)),
                  opacity: Math.min(0.85, 0.35 + (t.score / Math.max(maxScore, 1)) * 0.5),
                  lineCap: 'round',
                  lineJoin: 'round',
                }}
              />
            ))}
            {tracks.length > 0 && <AutoFit tracks={tracks} />}
          </MapContainer>

          {/* Legend */}
          <div style={{
            position: 'absolute', bottom: 12, right: 12, zIndex: 1000,
            background: 'rgba(8,8,8,0.85)', border: '1px solid var(--border)',
            padding: '0.5rem 0.75rem', fontSize: '0.6rem', color: 'var(--text-3)',
            letterSpacing: '0.05em', textTransform: 'uppercase',
          }}>
            <div style={{ marginBottom: '0.35rem' }}>Frequency</div>
            <div style={{
              width: 100, height: 6,
              background: 'linear-gradient(to right, #38bdf8, #ff6b2b, #ff1a1a)',
              marginBottom: '0.3rem',
            }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', width: 100 }}>
              <span>Rare</span><span>Often</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
