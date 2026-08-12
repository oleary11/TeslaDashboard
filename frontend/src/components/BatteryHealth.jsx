import React, { useEffect, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine, ResponsiveContainer } from 'recharts'
import { fetchDegradation, fetchBatteryHistory } from '../api'

const TT = {
  contentStyle: { background: '#111', border: '1px solid #222', borderRadius: 0, fontSize: '0.75rem' },
  labelStyle: { color: '#666', fontSize: '0.65rem', marginBottom: '0.2rem' },
  cursor: { stroke: '#333' },
}

export default function BatteryHealth() {
  const [degData, setDegData] = useState(null)
  const [history, setHistory] = useState([])
  const [days, setDays] = useState(30)

  useEffect(() => { fetchDegradation().then(setDegData) }, [])
  useEffect(() => { fetchBatteryHistory(days).then(setHistory) }, [days])

  const series = degData?.series ?? []
  const consumption = degData?.consumption_kwh_per_mi
  const consumptionSource = degData?.consumption_source
  const originalKwh = degData?.original_kwh ?? 74
  const epaRange = degData?.epa_miles ?? 310

  const latest = series[series.length - 1]
  const degradePct = latest
    ? Math.round((1 - latest.estimated_capacity_kwh / originalKwh) * 100)
    : null

  const realWorldRange = (latest && consumption)
    ? Math.round(latest.estimated_capacity_kwh / consumption)
    : null
  const epaProjectedRange = (latest)
    ? Math.round(latest.estimated_capacity_kwh / (originalKwh / epaRange))
    : null

  return (
    <div>
      {latest && (
        <>
          <div className="stat-grid">
            <div className="stat">
              <div className="val accent">{latest.estimated_capacity_kwh}</div>
              <div className="lbl">Est. Capacity (kWh)</div>
            </div>
            <div className="stat">
              <div className="val">{originalKwh}</div>
              <div className="lbl">Original ({epaRange} mi EPA)</div>
            </div>
            <div className="stat">
              <div className={`val ${degradePct > 15 ? 'red' : degradePct > 8 ? 'accent' : 'green'}`}>
                {degradePct}%
              </div>
              <div className="lbl">Degradation</div>
            </div>
            <div className="stat">
              <div className={`val ${consumptionSource === 'epa_spec' ? 'muted' : 'accent'}`} style={{ fontSize: '1.25rem' }}>
                {consumption ? `${(consumption * 1000).toFixed(0)} Wh/mi` : '—'}
              </div>
              <div className="lbl" style={{ color: consumptionSource === 'epa_spec' ? 'var(--text-3)' : 'var(--accent)' }}>
                {consumptionSource === 'epa_spec' ? 'Consumption (EPA)' : 'Avg Consumption'}
              </div>
            </div>
          </div>

          {/* Real-world range card */}
          <div className="card" style={{ borderLeft: '3px solid var(--accent)', marginBottom: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.75rem' }}>
              <h2 style={{ margin: 0 }}>Your Real-World Range</h2>
              <span style={{ fontSize: '0.65rem', color: 'var(--text-3)' }}>
                {consumptionSource === 'drives' ? 'Based on your actual driving' : 'Based on EPA spec — drive more to calibrate'}
              </span>
            </div>
            <div className="stat-grid">
              <div className="stat">
                <div className="val green" style={{ fontSize: '1.8rem' }}>{realWorldRange ?? '—'} mi</div>
                <div className="lbl">Real-World Range</div>
              </div>
              <div className="stat">
                <div className="val">{epaProjectedRange ?? '—'} mi</div>
                <div className="lbl">EPA-Projected Range</div>
              </div>
              <div className="stat">
                <div className="val accent">{epaRange} mi</div>
                <div className="lbl">Original EPA Range</div>
              </div>
              <div className="stat">
                <div className={`val ${realWorldRange && realWorldRange < epaRange * 0.8 ? 'red' : 'muted'}`}>
                  {realWorldRange ? `${Math.round((realWorldRange / epaRange) * 100)}%` : '—'}
                </div>
                <div className="lbl">of Original EPA</div>
              </div>
            </div>
            {realWorldRange && epaProjectedRange && (
              <p style={{ fontSize: '0.7rem', color: 'var(--text-3)', margin: '0.75rem 0 0' }}>
                Real-world is {Math.abs(realWorldRange - epaProjectedRange)} mi {realWorldRange < epaProjectedRange ? 'below' : 'above'} EPA-projected —
                your {(consumption * 1000).toFixed(0)} Wh/mi vs EPA's {Math.round(originalKwh / epaRange * 1000)} Wh/mi.
              </p>
            )}
          </div>
        </>
      )}

      <div className="card">
        <h2>Battery Capacity Over Time</h2>
        <p className="card-note">
          Formula: (projected range ÷ SOC%) × {consumption ? `${(consumption * 1000).toFixed(0)} Wh/mi` : 'avg consumption'} · accuracy ±3%
        </p>
        {series.length > 1 ? (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={series}>
              <CartesianGrid strokeDasharray="0" stroke="#1a1a1a" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: '#555', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis domain={[45, originalKwh + 2]} tick={{ fill: '#555', fontSize: 10 }} unit=" kWh"
                axisLine={false} tickLine={false} width={48} />
              <Tooltip {...TT} formatter={v => [`${v} kWh`, 'Capacity']} />
              <ReferenceLine y={originalKwh} stroke="#333" strokeDasharray="4 4"
                label={{ value: `New ${originalKwh} kWh`, fill: '#444', fontSize: 10, position: 'right' }} />
              <Line type="monotone" dataKey="estimated_capacity_kwh" stroke="#ff6b2b"
                strokeWidth={2} dot={false} activeDot={{ r: 4, fill: '#ff6b2b' }} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="empty" style={{ padding: '2rem 0' }}>
            Chart builds up over days of data collection.
            {consumptionSource === 'epa_spec' && (
              <span style={{ display: 'block', marginTop: '0.5rem', fontSize: '0.7rem' }}>
                Using EPA spec until 50+ miles of drives are recorded.
              </span>
            )}
          </p>
        )}
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <h2 style={{ margin: 0 }}>Battery Level History</h2>
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            {[7, 30, 90].map(d => (
              <button key={d} onClick={() => setDays(d)} style={{
                background: days === d ? 'var(--accent)' : 'var(--surface-2)',
                color: days === d ? '#000' : 'var(--text-3)',
                border: `1px solid ${days === d ? 'var(--accent)' : 'var(--border)'}`,
                padding: '0.25rem 0.6rem',
                cursor: 'pointer',
                fontSize: '0.65rem',
                fontWeight: 700,
                letterSpacing: '0.06em',
              }}>
                {d}D
              </button>
            ))}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={history}>
            <CartesianGrid strokeDasharray="0" stroke="#1a1a1a" vertical={false} />
            <XAxis dataKey="ts" tickFormatter={v => v.slice(5, 10)} tick={{ fill: '#555', fontSize: 10 }}
              axisLine={false} tickLine={false} />
            <YAxis domain={[0, 100]} tick={{ fill: '#555', fontSize: 10 }} unit="%"
              axisLine={false} tickLine={false} width={35} />
            <Tooltip {...TT} />
            <Line type="monotone" dataKey="battery_level" stroke="#38bdf8" strokeWidth={1.5} dot={false}
              activeDot={{ r: 3, fill: '#38bdf8' }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
