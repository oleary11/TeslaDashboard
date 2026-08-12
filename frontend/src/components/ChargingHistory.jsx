import React, { useEffect, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell, ResponsiveContainer } from 'recharts'
import { fetchCharges, fetchChargesSummary, fetchLive, fetchGasSavings } from '../api'
import { fmtDate } from '../fmt'

const TT = {
  contentStyle: { background: '#111', border: '1px solid #222', borderRadius: 0, fontSize: '0.75rem', color: '#e5e5e5' },
  itemStyle: { color: '#e5e5e5' },
  labelStyle: { color: '#666', fontSize: '0.65rem', marginBottom: '0.2rem' },
  cursor: { fill: 'rgba(255,255,255,0.03)' },
}

export default function ChargingHistory() {
  const [charges, setCharges] = useState([])
  const [summary, setSummary] = useState(null)
  const [live, setLive] = useState(null)
  const [gasSavings, setGasSavings] = useState(null)
  const [mpg, setMpg] = useState(22)

  useEffect(() => {
    fetchCharges().then(setCharges)
    fetchChargesSummary().then(setSummary)
    fetchLive().then(setLive).catch(() => {})
    const iv = setInterval(() => fetchLive().then(setLive).catch(() => {}), 10000)
    return () => clearInterval(iv)
  }, [])

  useEffect(() => {
    fetchGasSavings(mpg).then(setGasSavings).catch(() => {})
  }, [mpg])

  const chartData = [...charges].reverse().slice(-30).map(c => ({
    date: (c.start_time || '').slice(5, 10),
    kwh: c.energy_added_kwh,
    fast: c.fast_charger,
  }))

  const isCharging = live?.charging_state === 'Charging'

  if (!charges.length && !summary && !isCharging) return <p className="empty">No charging sessions recorded yet.</p>

  const inputStyle = {
    background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)',
    padding: '0.25rem 0.5rem', fontSize: '0.75rem', fontFamily: 'inherit', width: 60, textAlign: 'center',
  }

  return (
    <div>
      {isCharging && live && (
        <div className="card" style={{ borderColor: 'rgba(0,230,118,0.3)', background: 'rgba(0,230,118,0.04)' }}>
          <h2 style={{ color: 'var(--green)' }}>Charging Now</h2>
          <div className="stat-grid" style={{ marginBottom: 0 }}>
            <div className="stat">
              <div className="val green">{live.battery_level}%</div>
              <div className="lbl">Battery</div>
            </div>
            <div className="stat">
              <div className="val green">{live.charge_rate > 0 ? `+${live.charge_rate}` : '—'}</div>
              <div className="lbl">mph / hr</div>
            </div>
            <div className="stat">
              <div className="val green">{Math.round(live.battery_range)} mi</div>
              <div className="lbl">Range</div>
            </div>
            <div className="stat">
              <div className="val muted">{live.power != null ? `${live.power} kW` : '—'}</div>
              <div className="lbl">Power</div>
            </div>
          </div>
        </div>
      )}

      {/* Gas savings */}
      {gasSavings && (
        <div className="card" style={{ borderLeft: '3px solid #22c55e', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.75rem' }}>
            <h2 style={{ margin: 0 }}>Gas Money Saved</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.65rem', color: 'var(--text-3)' }}>
              <span>vs</span>
              <input
                type="number" value={mpg} min={10} max={60}
                onChange={e => setMpg(Number(e.target.value))}
                style={inputStyle}
              />
              <span>mpg gas car</span>
            </div>
          </div>
          <div className="stat-grid">
            <div className="stat">
              <div className="val green" style={{ fontSize: '1.8rem' }}>
                {gasSavings.gas_cost_avoided != null ? `$${gasSavings.gas_cost_avoided.toLocaleString()}` : '—'}
              </div>
              <div className="lbl">Total Saved</div>
            </div>
            <div className="stat">
              <div className="val">{gasSavings.gas_equivalent_gallons.toLocaleString()}</div>
              <div className="lbl">Gallons Not Burned</div>
            </div>
            <div className="stat">
              <div className="val accent">
                ${gasSavings.gas_price_per_gallon.toFixed(2)}
              </div>
              <div className="lbl">
                Rocky Mtn Gas Price
                {gasSavings.price_is_live && gasSavings.gas_price_date
                  ? ` (${gasSavings.gas_price_date})`
                  : ' (est.)'}
              </div>
            </div>
            <div className="stat">
              <div className="val">{gasSavings.total_miles.toLocaleString()}</div>
              <div className="lbl">Miles Driven Electric</div>
            </div>
          </div>
          {!gasSavings.has_eia_key && (
            <p style={{ fontSize: '0.65rem', color: 'var(--text-3)', margin: '0.75rem 0 0' }}>
              Using estimated price ($3.40/gal). Set <code style={{ color: 'var(--accent)' }}>EIA_API_KEY</code> in your .env for live Rocky Mountain region prices from eia.gov.
            </p>
          )}
        </div>
      )}

      {summary && (
        <div className="stat-grid">
          <div className="stat"><div className="val accent">{summary.total_sessions}</div><div className="lbl">Sessions</div></div>
          <div className="stat"><div className="val">{summary.total_kwh}</div><div className="lbl">Total kWh</div></div>
          <div className="stat"><div className="val">{summary.avg_kwh}</div><div className="lbl">Avg / Session</div></div>
          <div className="stat"><div className="val">{summary.supercharger_sessions}</div><div className="lbl">Supercharger</div></div>
          <div className="stat"><div className="val">{summary.total_miles_added?.toLocaleString() ?? '—'}</div><div className="lbl">Miles Added</div></div>
        </div>
      )}

      {chartData.length > 0 && (
        <div className="card">
          <h2>Energy Added — Last 30 Sessions</h2>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData} barCategoryGap="30%">
              <CartesianGrid strokeDasharray="0" stroke="#1a1a1a" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: '#555', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#555', fontSize: 10 }} unit=" kWh" axisLine={false} tickLine={false} width={45} />
              <Tooltip {...TT} />
              <Bar dataKey="kwh" radius={0} maxBarSize={28}>
                {chartData.map((d, i) => (
                  <Cell key={i} fill={d.fast ? '#ff6b2b' : '#38bdf8'} fillOpacity={0.85} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: '1rem', marginTop: '0.75rem' }}>
            <span style={{ fontSize: '0.65rem', color: 'var(--text-3)' }}>
              <span style={{ display: 'inline-block', width: 8, height: 8, background: '#ff6b2b', marginRight: 5 }} />Supercharger
            </span>
            <span style={{ fontSize: '0.65rem', color: 'var(--text-3)' }}>
              <span style={{ display: 'inline-block', width: 8, height: 8, background: '#38bdf8', marginRight: 5 }} />AC
            </span>
          </div>
        </div>
      )}

      {charges.length > 0 && (
        <div className="card">
          <h2>Session Log</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th><th>Start</th><th>End</th><th>Added</th>
                  <th>Miles Added</th><th>Max Power</th><th>Type</th>
                </tr>
              </thead>
              <tbody>
                {charges.map((c, i) => (
                  <tr key={i}>
                    <td style={{ color: 'var(--text)' }}>{fmtDate(c.start_time)}</td>
                    <td>{c.start_soc != null ? `${c.start_soc}%` : '—'}</td>
                    <td style={{ color: 'var(--green)' }}>{c.end_soc != null ? `${c.end_soc}%` : '—'}</td>
                    <td style={{ color: 'var(--text)' }}>{c.energy_added_kwh != null ? `${c.energy_added_kwh} kWh` : '—'}</td>
                    <td>{c.charge_miles_added ? `${Math.round(c.charge_miles_added)} mi` : '—'}</td>
                    <td>{c.max_charger_power ? `${c.max_charger_power} kW` : '—'}</td>
                    <td><span className={`badge ${c.fast_charger ? 'badge-sc' : 'badge-ac'}`}>{c.fast_charger ? 'SC' : 'AC'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
