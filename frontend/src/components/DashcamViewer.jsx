import React, { useEffect, useMemo, useRef, useState } from 'react'
import { dashcamMediaUrl, dashcamPreviewUrl, deleteDashcamEvent, exportDashcamEdit, fetchDashcamEvents, uploadDashcamFile } from '../api'

const CAMERAS = {
  front: { name: 'Front', icon: '↑' },
  back: { name: 'Rear', icon: '↓' },
  left_repeater: { name: 'Left', icon: '←' },
  right_repeater: { name: 'Right', icon: '→' },
  left_pillar: { name: 'Left pillar', icon: '↖' },
  right_pillar: { name: 'Right pillar', icon: '↗' },
}
const CAMERA_ORDER = Object.keys(CAMERAS)
const CLIP_RE = /-(front|back|left_repeater|right_repeater|left_pillar|right_pillar)\.mp4$/i

const eventDisplayCamera = event => event?.cameras[event?.event_camera] ? event.event_camera : CAMERA_ORDER.find(key => event?.cameras[key])

const stampDate = stamp => new Date(stamp.replace('_', 'T').replace(/-(\d{2})-(\d{2})$/, ':$1:$2'))
const formatStamp = stamp => stampDate(stamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
const formatTime = value => `${Math.floor((value || 0) / 60)}:${String(Math.floor((value || 0) % 60)).padStart(2, '0')}`
const formatBytes = bytes => bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(0)} MB`

export default function DashcamViewer() {
  const [library, setLibrary] = useState({ events: [], total_bytes: 0, media_token: '' })
  const [selectedId, setSelectedId] = useState(null)
  const [camera, setCamera] = useState('front')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('All')
  const [showAll, setShowAll] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(1)
  const [segments, setSegments] = useState([])
  const [selectedSegment, setSelectedSegment] = useState(0)
  const [crop, setCrop] = useState('original')
  const [upload, setUpload] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [message, setMessage] = useState('')
  const videoRef = useRef(null)
  const pendingTime = useRef(0)

  const refreshLibrary = async keepSelection => {
    try {
      const data = await fetchDashcamEvents()
      setLibrary(data)
      if (!keepSelection) setSelectedId((data.events.find(event => event.is_event) || data.events[0])?.id || null)
    } catch { setMessage('Could not load the video library.') }
  }

  useEffect(() => { refreshLibrary(false) }, [])

  const selected = library.events.find(event => event.id === selectedId) || library.events[0]
  const availableCamera = selected?.cameras[camera] ? camera : CAMERA_ORDER.find(key => selected?.cameras[key])
  const source = selected?.cameras[availableCamera]

  const filtered = useMemo(() => library.events.filter(event => {
    const matchesType = filter === 'All' || event.type === filter
    const haystack = `${formatStamp(event.timestamp)} ${event.type}`.toLowerCase()
    return (showAll || event.is_event) && matchesType && haystack.includes(query.toLowerCase())
  }), [library.events, filter, query, showAll])

  useEffect(() => {
    const initialTime = selected?.is_event ? Number(selected.event_offset || 0) : 0
    pendingTime.current = initialTime
    if (selected?.event_camera && selected.cameras[selected.event_camera]) setCamera(selected.event_camera)
    else if (!selected?.cameras[camera]) setCamera(CAMERA_ORDER.find(key => selected?.cameras[key]) || 'front')
    setPlaying(false)
    setTime(initialTime)
    setDuration(0)
    setSegments([])
    setSelectedSegment(0)
    setCrop('original')
  }, [selected?.id])

  const chooseCamera = key => {
    if (!selected?.cameras[key] || key === availableCamera) return
    pendingTime.current = videoRef.current?.currentTime || time
    setCamera(key)
    setPlaying(false)
  }

  const onMetadata = event => {
    const length = Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0
    setDuration(length)
    if (!segments.length && length) setSegments([{ path: source.path, start: 0, end: length }])
    event.currentTarget.currentTime = Math.min(pendingTime.current, length || 0)
    setTime(event.currentTarget.currentTime)
    pendingTime.current = 0
    event.currentTarget.playbackRate = rate
  }

  const togglePlay = () => {
    if (!videoRef.current) return
    if (videoRef.current.paused) videoRef.current.play().then(() => setPlaying(true)).catch(() => {})
    else { videoRef.current.pause(); setPlaying(false) }
  }

  const seek = value => {
    const next = Number(value)
    if (videoRef.current) videoRef.current.currentTime = next
    setTime(next)
  }

  const changeRate = value => {
    const next = Number(value)
    setRate(next)
    if (videoRef.current) videoRef.current.playbackRate = next
  }

  const patchSegment = (index, values) => setSegments(current => current.map((segment, i) => i === index ? { ...segment, ...values } : segment))

  const splitSegment = () => {
    const segment = segments[selectedSegment]
    if (!segment || time <= segment.start + 0.1 || time >= segment.end - 0.1) {
      setMessage('Move the playhead inside the selected segment to split it.')
      return
    }
    setSegments(current => [...current.slice(0, selectedSegment), { ...segment, end: time }, { ...segment, start: time }, ...current.slice(selectedSegment + 1)])
    setSelectedSegment(selectedSegment + 1)
    setMessage('')
  }

  const removeSegment = index => {
    if (segments.length === 1) return
    setSegments(current => current.filter((_, i) => i !== index))
    setSelectedSegment(Math.max(0, Math.min(index - 1, segments.length - 2)))
  }

  const moveSegment = (index, direction) => {
    const target = index + direction
    if (target < 0 || target >= segments.length) return
    setSegments(current => {
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
    setSelectedSegment(target)
  }

  const uploadFolder = async event => {
    const files = Array.from(event.target.files).filter(file => CLIP_RE.test(file.name))
    event.target.value = ''
    if (!files.length) { setMessage('No TeslaCam MP4 files were found in that folder.'); return }
    const total = files.reduce((sum, file) => sum + file.size, 0)
    let completed = 0
    setUpload({ done: 0, count: files.length, total })
    setMessage('')
    try {
      for (const file of files) {
        const path = file.webkitRelativePath || file.name
        await uploadDashcamFile(file, path, loaded => setUpload({ done: completed + loaded, count: files.length, total }))
        completed += file.size
      }
      await refreshLibrary(false)
      setMessage(`${files.length} camera files added to your library.`)
    } catch (error) {
      setMessage(error.message)
    } finally { setUpload(null) }
  }

  const exportEdit = async () => {
    if (!segments.length) return
    setExporting(true)
    setMessage('Rendering your edit…')
    try {
      const blob = await exportDashcamEdit(segments, crop)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `TeslaCam-${selected.timestamp}-${availableCamera}-edit.mp4`
      anchor.click()
      URL.revokeObjectURL(url)
      setMessage('Edit exported successfully.')
    } catch (error) { setMessage(error.message) }
    finally { setExporting(false) }
  }

  const removeEvent = async event => {
    if (deleteConfirm !== event.id) { setDeleteConfirm(event.id); return }
    setDeleting(event.id)
    try {
      const result = await deleteDashcamEvent(Object.values(event.cameras).map(item => item.path))
      setDeleteConfirm(null)
      setSelectedId(null)
      await refreshLibrary(false)
      setMessage(`${result.deleted === 'event' ? 'Event' : 'Clip'} deleted · ${formatBytes(result.bytes)} reclaimed.`)
    } catch (error) { setMessage(error.message) }
    finally { setDeleting(null) }
  }

  return (
    <section className={`dashcam ${editorOpen ? 'dashcam-editing' : ''}`}>
      <div className="dashcam-heading">
        <div>
          <div className="dashcam-eyebrow">TeslaCam Studio</div>
          <h1>Your drives, from every angle.</h1>
          <p>Fast local playback and simple edits. Originals always remain untouched.</p>
        </div>
        <label className={`dashcam-folder-btn ${upload ? 'disabled' : ''}`}>
          <span>{upload ? 'Uploading…' : '+ Import TeslaCam'}</span>
          <input type="file" webkitdirectory="" directory="" multiple accept="video/mp4" disabled={!!upload} onChange={uploadFolder} />
        </label>
      </div>

      {upload && <div className="dashcam-upload"><div><span style={{ width: `${Math.min(100, upload.done / upload.total * 100)}%` }} /></div><p>{formatBytes(upload.done)} of {formatBytes(upload.total)}</p></div>}
      {message && <button className="dashcam-message" onClick={() => setMessage('')}>{message}<span>×</span></button>}

      {!library.events.length && !upload ? (
        <label className="dashcam-dropzone">
          <span className="dashcam-drive-icon">▰</span>
          <strong>Connect your Tesla USB drive</strong>
          <p>Choose its TeslaCam folder. Clips upload directly to this home server and will be waiting here next time.</p>
          <span className="dashcam-drop-action">Choose folder</span>
          <input type="file" webkitdirectory="" directory="" multiple accept="video/mp4" onChange={uploadFolder} />
        </label>
      ) : library.events.length ? (
        <div className="dashcam-workspace">
          <aside className="dashcam-library">
            <div className="dashcam-library-head"><strong>Library</strong><span>{library.events.length} events · {formatBytes(library.total_bytes)}</span></div>
            <div className="dashcam-filters">
              <input className="input" type="search" placeholder="Search clips" value={query} onChange={e => setQuery(e.target.value)} />
              <div className="dashcam-filter-row">{['All', 'Sentry', 'Saved', 'Recent'].map(item => <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item}</button>)}</div>
              <label className="dashcam-show-all"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /><span>Show non-event footage</span></label>
            </div>
            <div className="dashcam-list">
              {filtered.map(event => <div key={event.id} className={`dashcam-event ${selected?.id === event.id ? 'active' : ''} ${deleteConfirm === event.id ? 'confirming' : ''}`}>
                <button className="dashcam-event-main" onClick={() => { setSelectedId(event.id); setDeleteConfirm(null) }}>
                  <span className="dashcam-thumb">{eventDisplayCamera(event) ? <img loading="lazy" src={dashcamPreviewUrl(event.cameras[eventDisplayCamera(event)].path, event.event_offset || 0, library.media_token)} alt={`${CAMERAS[eventDisplayCamera(event)].name} camera at event`} /> : <span>▶</span>}<i className={`type-${event.type.toLowerCase()}`} /></span>
                  <span className="dashcam-event-copy"><strong>{formatStamp(event.timestamp)}</strong><small>{event.event_label || event.type} · {Object.keys(event.cameras).length} angles</small><small>{formatBytes(event.bytes)}</small></span>
                </button>
                <button className="dashcam-event-delete" disabled={deleting === event.id} onClick={() => removeEvent(event)} title={deleteConfirm === event.id ? 'Click again to permanently delete' : 'Delete clip'}>{deleting === event.id ? '…' : deleteConfirm === event.id ? 'Delete?' : '×'}</button>
              </div>)}
              {!filtered.length && <div className="empty">No matching clips</div>}
            </div>
          </aside>

          <div className="dashcam-stage">
            {editorOpen && <div className="dashcam-editor-topbar"><div><strong>TeslaCam Studio</strong><span>{formatStamp(selected.timestamp)} · {CAMERAS[availableCamera]?.name}</span></div><button onClick={() => setEditorOpen(false)}>Done</button></div>}
            <div className="dashcam-stage-head">
              <div><span className={`dashcam-type type-${selected.type.toLowerCase()}`}>{selected.event_label || selected.type}</span><strong>{formatStamp(selected.timestamp)}</strong></div>
              <div className="dashcam-stage-actions">{selected.is_event && <button onClick={() => seek(selected.event_offset)}>Jump to event · {formatTime(selected.event_offset)}</button>}<button onClick={() => setEditorOpen(true)}>Open editor</button></div>
            </div>
            <div className={`dashcam-video-frame crop-${crop.replace(':', '-')}`}>
              <video
                key={source?.path}
                ref={videoRef}
                src={source ? dashcamMediaUrl(source.path, library.media_token) : ''}
                playsInline muted preload="metadata"
                onLoadedMetadata={onMetadata}
                onTimeUpdate={e => setTime(e.currentTarget.currentTime)}
                onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)} onClick={togglePlay}
              />
              {!playing && <button className="dashcam-center-play" onClick={togglePlay}>▶</button>}
              <span className="dashcam-camera-label">{CAMERAS[availableCamera]?.name}</span>
              {selected.is_event && <span className="dashcam-event-badge">● {selected.event_label} at {formatTime(selected.event_offset)}</span>}
            </div>

            <div className="dashcam-angle-picker">
              {CAMERA_ORDER.map(key => <button key={key} disabled={!selected.cameras[key]} className={availableCamera === key ? 'active' : ''} onClick={() => chooseCamera(key)}>
                <span>{CAMERAS[key].icon}</span><strong>{CAMERAS[key].name}</strong><small>{selected.cameras[key] ? 'Available' : 'Missing'}</small>
              </button>)}
            </div>

            <div className="dashcam-transport">
              <button className="dashcam-play" onClick={togglePlay}>{playing ? 'Ⅱ' : '▶'}</button>
              <span>{formatTime(time)}</span>
              <input type="range" min="0" max={duration || 1} step="0.04" value={Math.min(time, duration || 0)} onChange={e => seek(e.target.value)} />
              <span>{formatTime(duration)}</span>
              <select value={rate} onChange={e => changeRate(e.target.value)}><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select>
            </div>

            {editorOpen && <div className="dashcam-editor">
              <div className="dashcam-editor-head"><div><strong>Quick editor</strong><span>Split, trim, rearrange and crop</span></div><button onClick={splitSegment}>Split at playhead</button></div>
              <div className="dashcam-timeline-ruler">{[0, .25, .5, .75, 1].map(point => <span key={point} style={{ left: `${point * 100}%` }}>{formatTime(duration * point)}</span>)}</div>
              <div className="dashcam-segments">
                {segments.map((segment, index) => <button key={`${segment.start}-${segment.end}-${index}`} style={{ flex: Math.max(.08, (segment.end - segment.start) / (duration || 1)) }} className={selectedSegment === index ? 'active' : ''} onClick={() => { setSelectedSegment(index); seek(segment.start) }}>
                  <span>Segment {index + 1}</span><strong>{formatTime(segment.start)}–{formatTime(segment.end)}</strong>
                </button>)}
                <i className="dashcam-playhead" style={{ left: `${duration ? time / duration * 100 : 0}%` }} />
              </div>
              {segments[selectedSegment] && <div className="dashcam-edit-tools">
                <label>In <input type="number" min="0" max={segments[selectedSegment].end - 0.1} step="0.1" value={segments[selectedSegment].start.toFixed(1)} onChange={e => patchSegment(selectedSegment, { start: Math.min(Number(e.target.value), segments[selectedSegment].end - 0.1) })} /></label>
                <button onClick={() => patchSegment(selectedSegment, { start: time })}>Set in</button>
                <label>Out <input type="number" min={segments[selectedSegment].start + 0.1} max={duration} step="0.1" value={segments[selectedSegment].end.toFixed(1)} onChange={e => patchSegment(selectedSegment, { end: Math.max(Number(e.target.value), segments[selectedSegment].start + 0.1) })} /></label>
                <button onClick={() => patchSegment(selectedSegment, { end: time })}>Set out</button>
                <button title="Move earlier" onClick={() => moveSegment(selectedSegment, -1)}>←</button>
                <button title="Move later" onClick={() => moveSegment(selectedSegment, 1)}>→</button>
                <button className="danger" disabled={segments.length === 1} onClick={() => removeSegment(selectedSegment)}>Remove</button>
              </div>}
              <div className="dashcam-export-row">
                <div className="dashcam-crop"><span>Crop</span>{['original', '16:9', '1:1', '9:16'].map(value => <button key={value} className={crop === value ? 'active' : ''} onClick={() => setCrop(value)}>{value === 'original' ? 'Original' : value}</button>)}</div>
                <div className="dashcam-export-summary"><span>{segments.length} segment{segments.length !== 1 ? 's' : ''} · {formatTime(segments.reduce((sum, s) => sum + s.end - s.start, 0))}</span><button disabled={exporting || !segments.length} onClick={exportEdit}>{exporting ? 'Rendering…' : 'Export edit'}</button></div>
              </div>
            </div>}
          </div>
        </div>
      ) : null}
    </section>
  )
}
