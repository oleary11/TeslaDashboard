const B = '/api'

export const getToken = () => localStorage.getItem('token')

const authHeaders = () => {
  const t = getToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

const h = () => ({ headers: authHeaders() })
const hj = () => ({ headers: { ...authHeaders(), 'Content-Type': 'application/json' } })

export const login = (username, password) =>
  fetch(`${B}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) }).then(r => { if (!r.ok) throw r; return r.json() })

export const fetchMe = () =>
  fetch(`${B}/auth/me`, h()).then(r => { if (r.status === 401) throw new Error('401'); return r.json() })

export const fetchAuthStatus = () => fetch(`${B}/auth/status`, h()).then(r => r.json())
export const fetchVehicle = () => fetch(`${B}/vehicle`, h()).then(r => r.json())
export const fetchVehicleImage = () => fetch(`${B}/vehicle/image`, h()).then(r => r.json())
export const fetchLive = () => fetch(`${B}/vehicle/live`, h()).then(r => r.json())
export const fetchCharges = () => fetch(`${B}/charges`, h()).then(r => r.json())
export const fetchChargesSummary = () => fetch(`${B}/charges/summary`, h()).then(r => r.json())
export const fetchDrives = () => fetch(`${B}/drives`, h()).then(r => r.json())
export const fetchCommutes = () => fetch(`${B}/drives/commutes`, h()).then(r => r.json())
export const fetchEfficiency = () => fetch(`${B}/drives/efficiency`, h()).then(r => r.json())
export const fetchDegradation = () => fetch(`${B}/battery/degradation`, h()).then(r => r.json())
export const fetchBatteryHistory = (days = 30) => fetch(`${B}/battery/history?days=${days}`, h()).then(r => r.json())
export const fetchStops = () => fetch(`${B}/stops`, h()).then(r => r.json())
export const deleteStopCluster = (lat, lon) =>
  fetch(`${B}/stops`, { method: 'DELETE', ...hj(), body: JSON.stringify({ lat, lon }) }).then(r => { if (!r.ok) throw r; return r.json() })
export const fetchTracks = (start = '', end = '') => {
  const q = new URLSearchParams()
  if (start) q.set('start', start)
  if (end) q.set('end', end)
  const qs = q.toString()
  return fetch(`${B}/drives/tracks${qs ? '?' + qs : ''}`, h()).then(r => r.json())
}
export const fetchConfig = () => fetch(`${B}/config`, h()).then(r => r.json())
export const triggerRefresh = () => fetch(`${B}/refresh`, { method: 'POST', ...h() }).then(r => r.json())
export const fetchAccelerationRuns = () => fetch(`${B}/acceleration/runs`, h()).then(r => r.json())
export const fetchTelemetryTopSpeed = () => fetch(`${B}/acceleration/top-speed`, h()).then(r => r.json())
export const fetchDriveTrack = (driveId) => fetch(`${B}/drives/${driveId}/track`, h()).then(r => r.json())
export const fetchOptimalDeparture = (dir = 'to_work') => fetch(`${B}/drives/commutes/optimal-departure?direction=${dir}`, h()).then(r => r.json())
export const fetchMonthlyDrives = () => fetch(`${B}/drives/monthly`, h()).then(r => r.json())
export const fetchDestinations = () => fetch(`${B}/drives/destinations`, h()).then(r => r.json())
export const fetchSpeedHistogram = () => fetch(`${B}/drives/speed-histogram`, h()).then(r => r.json())
export const fetchGasSavings = (mpg = 28) => fetch(`${B}/charges/gas-savings?mpg=${mpg}`, h()).then(r => r.json())
export const fetchGarage = () => fetch(`${B}/garage`, h()).then(r => r.json())
export const fetchDashcamEvents = () => fetch(`${B}/dashcam/events`, h()).then(r => { if (!r.ok) throw r; return r.json() })
export const uploadDashcamFile = (file, path, onProgress) => new Promise((resolve, reject) => {
  const xhr = new XMLHttpRequest()
  xhr.open('PUT', `${B}/dashcam/files?path=${encodeURIComponent(path)}`)
  const token = getToken()
  if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
  xhr.setRequestHeader('Content-Type', 'video/mp4')
  xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress?.(event.loaded, event.total) }
  xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(`Upload failed (${xhr.status})`))
  xhr.onerror = () => reject(new Error('Upload connection failed'))
  xhr.send(file)
})
export const dashcamMediaUrl = (path, mediaToken) => `${B}/dashcam/media?path=${encodeURIComponent(path)}&media_token=${encodeURIComponent(mediaToken)}`
export const dashcamPreviewUrl = (path, at, mediaToken) => `${B}/dashcam/preview?path=${encodeURIComponent(path)}&at=${encodeURIComponent(at)}&media_token=${encodeURIComponent(mediaToken)}`
export const deleteDashcamEvent = camera_paths =>
  fetch(`${B}/dashcam/events`, { method: 'DELETE', ...hj(), body: JSON.stringify({ camera_paths }) }).then(async r => { if (!r.ok) throw new Error((await r.json()).detail || 'Delete failed'); return r.json() })
export const exportDashcamEdit = (segments, crop) =>
  fetch(`${B}/dashcam/edit`, { method: 'POST', ...hj(), body: JSON.stringify({ segments, crop }) }).then(async r => { if (!r.ok) throw new Error((await r.json()).detail || 'Export failed'); return r.blob() })
export const fetchUsers = () => fetch(`${B}/users`, h()).then(r => r.json())
export const createUser = (username, password) =>
  fetch(`${B}/users`, { method: 'POST', ...hj(), body: JSON.stringify({ username, password }) }).then(r => { if (!r.ok) throw r; return r.json() })
export const deleteUser = id =>
  fetch(`${B}/users/${id}`, { method: 'DELETE', ...h() }).then(r => r.json())
export const setUserSubdomain = (id, subdomain) =>
  fetch(`${B}/users/${id}/subdomain`, { method: 'PATCH', ...hj(), body: JSON.stringify({ subdomain }) }).then(r => { if (!r.ok) throw r; return r.json() })
export const updateMyVisibility = visible =>
  fetch(`${B}/users/me`, { method: 'PATCH', ...hj(), body: JSON.stringify({ visible_in_garage: visible }) }).then(r => r.json())
export const updateMyLocation = (home_lat, home_lon, work_lat, work_lon) =>
  fetch(`${B}/users/me/location`, { method: 'PATCH', ...hj(), body: JSON.stringify({ home_lat, home_lon, work_lat, work_lon }) }).then(r => { if (!r.ok) throw r; return r.json() })
export const fetchAuthUrl = () => fetch(`${B}/auth/url`, h()).then(r => { if (!r.ok) throw r; return r.json() })
export const fetchAuthCredentials = () => fetch(`${B}/auth/credentials`, h()).then(r => r.json())
export const saveAuthCredentials = (client_id, client_secret) =>
  fetch(`${B}/auth/credentials`, { method: 'POST', ...hj(), body: JSON.stringify({ client_id, client_secret }) }).then(r => { if (!r.ok) throw r; return r.json() })
