import React, { useEffect, useState } from 'react'
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { fetchVehicleImage } from '../api'
import { fmtDateTime } from '../fmt'

const fmtTemp = c => c != null ? `${Math.round(c * 9 / 5 + 32)}°F` : '—'
const fmt = (v, unit = '') => v != null ? `${v}${unit}` : '—'

function arrowIcon(heading, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <g transform="rotate(${heading}, 16, 16)">
      <polygon points="16,4 24,26 16,21 8,26" fill="${color}" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/>
    </g>
  </svg>`
  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  })
}

function PanTo({ lat, lon }) {
  const map = useMap()
  React.useEffect(() => { map.panTo([lat, lon]) }, [lat, lon])
  return null
}

export default function LiveStatus({ live }) {
  const [imgUrl, setImgUrl] = useState(null)
  useEffect(() => {
    fetchVehicleImage().then(d => setImgUrl(d.url)).catch(() => {})
  }, [])

  if (!live) return (
    <p className="empty">No live data yet — car hasn't been polled.<br />Data will appear once the car wakes up.</p>
  )

  const isDriving = live.is_driving
  const isCharging = live.charging_state === 'Charging'
  const status = isDriving ? 'Driving' : isCharging ? 'Charging' : live.charging_state === 'Complete' ? 'Charge Complete' : 'Parked'
  const dotColor = isDriving ? '#38bdf8' : isCharging ? '#00e676' : '#555'

  return (
    <div>
      {imgUrl && (
        <div style={{ textAlign: 'center', marginBottom: '1rem', background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <img
            src={imgUrl}
            alt="Vehicle render"
            style={{ width: '100%', maxWidth: 640, display: 'block', margin: '0 auto' }}
          />
        </div>
      )}
      <div className="stat-grid" style={{ marginBottom: '1rem' }}>
        <div className="stat">
          <div className={`val ${live.battery_level < 20 ? 'red' : ''}`}>{live.battery_level}%</div>
          <div className="lbl">Battery</div>
        </div>
        <div className="stat">
          <div className="val">{Math.round(live.battery_range)}</div>
          <div className="lbl">Miles Range</div>
        </div>
        <div className="stat">
          <div className={`val ${isDriving ? 'accent' : 'muted'}`}>{fmt(live.speed, ' mph')}</div>
          <div className="lbl">Speed</div>
        </div>
        <div className="stat">
          <div className={`val ${live.power > 0 ? 'red' : live.power < 0 ? 'green' : 'muted'}`}>
            {fmt(live.power, ' kW')}
          </div>
          <div className="lbl">Power</div>
        </div>
        <div className="stat">
          <div className="val muted">{fmtTemp(live.outside_temp)}</div>
          <div className="lbl">Outside</div>
        </div>
        <div className="stat">
          <div className="val muted">{fmtTemp(live.inside_temp)}</div>
          <div className="lbl">Inside</div>
        </div>
        <div className="stat">
          <div className={`val ${isCharging ? 'green' : 'muted'}`}>{fmt(live.charge_rate, ' mph')}</div>
          <div className="lbl">Charge Rate</div>
        </div>
        <div className="stat">
          <div className="val muted" style={{ fontSize: '1rem', paddingTop: '0.35rem' }}>{status}</div>
          <div className="lbl">Status</div>
        </div>
      </div>

      {live.latitude && live.longitude && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ height: 320 }}>
            <MapContainer
              center={[live.latitude, live.longitude]}
              zoom={15}
              style={{ height: '100%', width: '100%' }}
              zoomControl={true}
              attributionControl={false}
            >
              <TileLayer
                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                subdomains="abcd"
                maxZoom={19}
              />
              <Marker
                position={[live.latitude, live.longitude]}
                icon={arrowIcon(live.heading ?? 0, '#00e676')}
              />
              <PanTo lat={live.latitude} lon={live.longitude} />
            </MapContainer>
          </div>
          {live.heading != null && (
            <div style={{ padding: '0.5rem 1rem', borderTop: '1px solid var(--border)', fontSize: '0.65rem', color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              {live.latitude.toFixed(5)}, {live.longitude.toFixed(5)} &nbsp;·&nbsp; {live.heading}° heading
            </div>
          )}
        </div>
      )}

      <p style={{ color: 'var(--text-3)', fontSize: '0.65rem', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: '0.75rem' }}>
        Updated {fmtDateTime(live.ts)}
      </p>
    </div>
  )
}
