const AZ = 'America/Phoenix'

export const fmtDate = iso =>
  iso ? new Date(iso).toLocaleDateString('en-US', { timeZone: AZ, month: '2-digit', day: '2-digit', year: 'numeric' }) : '—'

export const fmtTime = iso =>
  iso ? new Date(iso).toLocaleTimeString('en-US', { timeZone: AZ, hour: 'numeric', minute: '2-digit', hour12: true }) : '—'

export const fmtDateTime = iso =>
  iso ? new Date(iso).toLocaleString('en-US', { timeZone: AZ, month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : '—'
