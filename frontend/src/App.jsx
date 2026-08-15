import React, { useEffect, useState } from 'react'
import { fetchMe, fetchVehicle, fetchLive, triggerRefresh, fetchVehicleImage } from './api'
import Login from './components/Login'
import LiveStatus from './components/LiveStatus'
import ChargingHistory from './components/ChargingHistory'
import BatteryHealth from './components/BatteryHealth'
import Drives from './components/Drives'
import Commutes from './components/Commutes'
import StopAnalysis from './components/StopAnalysis'
import Garage from './components/Garage'
import Profile from './components/Profile'
import AdminPanel from './components/AdminPanel'
import DashcamViewer from './components/DashcamViewer'
import './App.css'

const NAV_TABS = ['Live', 'Charging', 'Battery', 'Drives', 'Commutes', 'Stops', 'Dashcam', 'Garage']

export default function App() {
  const [authed, setAuthed] = useState(null)
  const [user, setUser] = useState(null)
  const [vehicle, setVehicle] = useState(null)
  const [live, setLive] = useState(null)
  const [carImgUrl, setCarImgUrl] = useState(null)
  const [tab, setTab] = useState(() => localStorage.getItem('activeTab') || 'Live')
  const [refreshing, setRefreshing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    fetchMe()
      .then(u => { setUser(u); setAuthed(true) })
      .catch(() => setAuthed(false))
  }, [])

  useEffect(() => {
    if (!authed) return
    fetchVehicle().then(setVehicle).catch(() => {})
    fetchVehicleImage().then(d => setCarImgUrl(d.url)).catch(() => {})
    fetchLive().then(setLive).catch(() => {})
    const iv = setInterval(() => fetchLive().then(setLive).catch(() => {}), 15000)
    return () => clearInterval(iv)
  }, [authed])

  const handleLogin = (token, u) => {
    localStorage.setItem('token', token)
    setUser(u)
    setAuthed(true)
  }

  const handleLogout = () => {
    localStorage.removeItem('token')
    setUser(null)
    setAuthed(false)
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    await triggerRefresh()
    setTimeout(() => setRefreshing(false), 3000)
  }

  const switchTab = t => { setTab(t); localStorage.setItem('activeTab', t); setMenuOpen(false) }

  if (authed === null) return <div className="loading">Connecting</div>
  if (!authed) return <Login onLogin={handleLogin} />

  const isDriving = live?.is_driving
  const isCharging = live?.charging_state === 'Charging'
  const statusClass = isDriving ? 'driving' : isCharging ? 'charging' : 'idle'
  const statusLabel = isDriving ? 'Driving' : isCharging ? 'Charging' : live?.charging_state === 'Complete' ? 'Charged' : 'Parked'

  return (
    <div className="app">
      <header className="header">
        <div className="header-row">
          {/* Brand + live status stacked on left */}
          <div className="header-brand">
            <div className="make">Tesla</div>
            <div className="model">{vehicle?.display_name || 'Dashboard'}</div>
          </div>

          {live && (
            <div className="header-live">
              <span className={`status-dot ${statusClass}`} />
              <span className="hl-soc">{live.battery_level}%</span>
              <span className="hl-range">{Math.round(live.battery_range)} mi</span>
              <span className={`hl-status ${statusClass}`}>{statusLabel}</span>
            </div>
          )}

          {/* Actions on right */}
          <div className="header-actions">
            <button className="refresh-btn" onClick={handleRefresh} disabled={refreshing} title="Sync">↺</button>
            <button
              className={`refresh-btn hide-mobile header-profile-btn ${tab === 'Profile' ? 'header-btn-active' : ''}`}
              onClick={() => switchTab(tab === 'Profile' ? 'Live' : 'Profile')}
            >
              {carImgUrl
                ? <img src={carImgUrl} alt="car" style={{ height: 28, display: 'block', margin: '0 auto -2px' }} />
                : null}
              <span>Profile</span>
            </button>
            {user?.is_admin && (
              <button
                className={`refresh-btn hide-mobile ${tab === 'Admin' ? 'header-btn-active' : ''}`}
                onClick={() => switchTab(tab === 'Admin' ? 'Live' : 'Admin')}
              >Admin</button>
            )}
            <button className="refresh-btn hide-mobile" onClick={handleLogout}>Log Out</button>
            {/* Hamburger — mobile only */}
            <button
              className="refresh-btn show-mobile hamburger"
              onClick={() => setMenuOpen(o => !o)}
              aria-label="Menu"
            >{menuOpen ? '✕' : '☰'}</button>
          </div>
        </div>

        {/* Desktop tab bar */}
        <nav className="tabs">
          {NAV_TABS.map(t => (
            <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => switchTab(t)}>{t}</button>
          ))}
        </nav>

        {/* Mobile slide-down menu */}
        {menuOpen && (
          <div className="mobile-menu">
            {NAV_TABS.map(t => (
              <button key={t} className={`mobile-menu-item ${tab === t ? 'active' : ''}`} onClick={() => switchTab(t)}>{t}</button>
            ))}
            <div className="mobile-menu-divider" />
            <button
              className={`mobile-menu-item ${tab === 'Profile' ? 'active' : ''}`}
              onClick={() => switchTab(tab === 'Profile' ? 'Live' : 'Profile')}
            >Profile</button>
            {user?.is_admin && (
              <button
                className={`mobile-menu-item ${tab === 'Admin' ? 'active' : ''}`}
                onClick={() => switchTab(tab === 'Admin' ? 'Live' : 'Admin')}
              >Admin</button>
            )}
            <div className="mobile-menu-divider" />
            <button className="mobile-menu-item mobile-menu-logout" onClick={handleLogout}>Log Out</button>
          </div>
        )}
      </header>

      <main className={`content ${tab === 'Dashcam' ? 'content-wide' : ''}`}>
        {tab === 'Live'     && <LiveStatus live={live} />}
        {tab === 'Charging' && <ChargingHistory />}
        {tab === 'Battery'  && <BatteryHealth />}
        {tab === 'Drives'   && <Drives />}
        {tab === 'Commutes' && <Commutes />}
        {tab === 'Stops'    && <StopAnalysis />}
        {tab === 'Dashcam'  && <DashcamViewer />}
        {tab === 'Garage'   && <Garage currentUser={user} />}
        {tab === 'Profile'  && <Profile user={user} onVisibilityChange={v => setUser(u => ({ ...u, visible_in_garage: v }))} />}
        {tab === 'Admin'    && <AdminPanel currentUser={user} />}
      </main>
    </div>
  )
}
