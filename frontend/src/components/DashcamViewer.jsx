import React, { useEffect, useMemo, useRef, useState } from 'react'
import { dashcamMediaUrl, deleteDashcamEvent, exportDashcamEdit, fetchDashcamEvents, fetchDashcamStorage, fetchExistingDashcamFiles, fetchTelemetryRange, uploadDashcamFile } from '../api'

const CAMERAS = {
  front: { name: 'Front', icon: '↑' },
  back: { name: 'Rear', icon: '↓' },
  left_repeater: { name: 'Left', icon: '←' },
  right_repeater: { name: 'Right', icon: '→' },
}
const CAMERA_ORDER = Object.keys(CAMERAS)
const CLIP_RE = /-(front|back|left_repeater|right_repeater)\.mp4$/i
const METADATA_RE = /^(event\.json|thumb\.png)$/i
const FRAME_COUNT = 6
const FRAME_W = 96
const FRAME_H = 54
const FALLBACK_CLIP_DURATION = 60
const MIN_PPS = 16
const RULER_STEP_CANDIDATES = [1, 2, 5, 10, 15, 30, 60, 120, 300]

// Plain vertical mouse-wheel scrolling doesn't move a horizontal-only overflow
// container in most browsers (needs Shift held, or a trackpad's horizontal
// gesture) — remap vertical wheel delta to horizontal scroll on `ref`'s element.
// React's onWheel is passive, so preventDefault has to happen via a real
// addEventListener with passive:false, hence a dedicated hook.
const useHorizontalWheelScroll = (ref, enabled) => {
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    const onWheel = event => {
      if (event.deltaY === 0 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
      el.scrollLeft += event.deltaY
      event.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [ref, enabled])
}

const stampDate = stamp => new Date(stamp.replace('_', 'T').replace(/-(\d{2})-(\d{2})$/, ':$1:$2'))
const formatStamp = stamp => stampDate(stamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
const formatTime = value => `${Math.floor((value || 0) / 60)}:${String(Math.floor((value || 0) % 60)).padStart(2, '0')}`
const formatBytes = bytes => bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(0)} MB`
const clipLength = segment => segment.end - segment.start
const segmentFrameKey = (path, segment) => `${path}|${segment.start.toFixed(1)}|${segment.end.toFixed(1)}`
const isBrakeActive = value => /true|applied|on|^1$|pressed/i.test(String(value ?? ''))

// Binary-search `points` (sorted by ts) for the sample closest to `wallMs`,
// ignoring matches further than `maxGapMs` away (stale/irrelevant telemetry).
const nearestTelemetrySample = (points, wallMs, maxGapMs = 20000) => {
  if (wallMs == null || !points.length) return null
  let lo = 0, hi = points.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (new Date(points[mid].ts).getTime() < wallMs) lo = mid + 1
    else hi = mid
  }
  let best = points[lo]
  if (lo > 0) {
    const prev = points[lo - 1]
    if (Math.abs(new Date(prev.ts).getTime() - wallMs) < Math.abs(new Date(best.ts).getTime() - wallMs)) best = prev
  }
  return Math.abs(new Date(best.ts).getTime() - wallMs) <= maxGapMs ? best : null
}

const SplitIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="2.6" /><circle cx="6" cy="18" r="2.6" /><path d="M8.5 7.5 20 16M8.5 16.5 20 8" /></svg>
const DuplicateIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M4 16V6a2 2 0 0 1 2-2h10" /></svg>
const DeleteIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /></svg>
const ExportIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11M8 11l4 4 4-4M5 19h14" /></svg>
const UndoIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-2" /></svg>

const probeDuration = (videoEl, path, mediaToken) => new Promise((resolve, reject) => {
  const cleanup = () => { videoEl.onloadedmetadata = null; videoEl.onerror = null; clearTimeout(timer) }
  const timer = setTimeout(() => { cleanup(); reject(new Error('probe timeout')) }, 8000)
  videoEl.onloadedmetadata = () => { const d = videoEl.duration; cleanup(); resolve(Number.isFinite(d) ? d : FALLBACK_CLIP_DURATION) }
  videoEl.onerror = () => { cleanup(); reject(new Error('probe failed')) }
  videoEl.src = dashcamMediaUrl(path, mediaToken)
  videoEl.load()
})

const captureSegmentFrames = (videoEl, segment, mediaToken) => new Promise((resolve, reject) => {
  const canvas = document.createElement('canvas')
  canvas.width = FRAME_W
  canvas.height = FRAME_H
  const ctx = canvas.getContext('2d')
  const frames = []
  let index = 0
  const supportsVFC = typeof videoEl.requestVideoFrameCallback === 'function'
  const cleanup = () => { videoEl.onloadedmetadata = null; videoEl.onseeked = null; videoEl.onerror = null }
  const grab = () => {
    try { ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height); frames.push(canvas.toDataURL('image/jpeg', 0.6)) }
    catch { frames.push(null) }
    index += 1
    captureNext()
  }
  const captureNext = () => {
    if (index >= FRAME_COUNT) { cleanup(); resolve(frames); return }
    const span = Math.max(0.1, segment.end - segment.start)
    const t = segment.start + ((index + 0.5) / FRAME_COUNT) * span
    const clamped = Math.min(t, Math.max(0, (videoEl.duration || segment.end) - 0.05))
    if (Math.abs(videoEl.currentTime - clamped) < 0.02) { grab(); return }
    if (supportsVFC) videoEl.requestVideoFrameCallback(grab)
    else videoEl.onseeked = () => requestAnimationFrame(() => requestAnimationFrame(grab))
    videoEl.currentTime = clamped
  }
  videoEl.onerror = () => { cleanup(); reject(new Error('video error')) }
  videoEl.onloadedmetadata = () => captureNext()
  videoEl.src = dashcamMediaUrl(segment.path, mediaToken)
  videoEl.load()
})

export default function DashcamViewer() {
  const [library, setLibrary] = useState({ events: [], total_bytes: 0, media_token: '' })
  const [storage, setStorage] = useState({ used_bytes: 0, max_bytes: null })
  const [selectedId, setSelectedId] = useState(null)
  const [camera, setCamera] = useState('front')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('All')
  const [showAll, setShowAll] = useState(true)
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
  const [videoError, setVideoError] = useState(null)
  const [videoLoading, setVideoLoading] = useState(false)
  const [frameCache, setFrameCache] = useState({})
  const [history, setHistory] = useState([])
  const [telemetry, setTelemetry] = useState([])
  const [trackWidth, setTrackWidth] = useState(0)
  const videoRef = useRef(null)
  const thumbVideoRef = useRef(null)
  const probeVideoRef = useRef(null)
  const thumbBusy = useRef(false)
  const pendingTime = useRef(0)
  const continuePlaying = useRef(false)
  const segmentsTrackRef = useRef(null)
  const libraryListRef = useRef(null)
  const tlTotalRef = useRef(0.1)
  const ppsRef = useRef(MIN_PPS)

  useHorizontalWheelScroll(segmentsTrackRef, editorOpen)
  useHorizontalWheelScroll(libraryListRef, library.events.length > 0)

  const refreshLibrary = async keepSelection => {
    try {
      const data = await fetchDashcamEvents()
      setLibrary(data)
      if (!keepSelection) setSelectedId((data.events.find(event => event.is_event) || data.events[0])?.id || null)
    } catch { setMessage('Could not load the video library.') }
    try { setStorage(await fetchDashcamStorage()) } catch { /* non-critical */ }
  }

  useEffect(() => { refreshLibrary(false) }, [])

  const selected = library.events.find(event => event.id === selectedId) || library.events[0]
  const clips = selected?.segments?.length ? selected.segments : selected ? [selected] : []

  const filtered = useMemo(() => library.events.filter(event => {
    const matchesType = filter === 'All' || event.type === filter
    const haystack = `${formatStamp(event.timestamp)} ${event.type}`.toLowerCase()
    return (showAll || event.is_event) && matchesType && haystack.includes(query.toLowerCase())
  }), [library.events, filter, query, showAll])

  const tlTotal = Math.max(0.1, segments.reduce((max, seg) => Math.max(max, seg.pos + clipLength(seg)), 0))
  useEffect(() => { tlTotalRef.current = tlTotal }, [tlTotal])

  // Fit the timeline to the visible track width when it's short enough to read
  // comfortably; once it'd get too cramped (long multi-clip events), hold a
  // legible minimum px/sec instead and let the track overflow — that's what
  // actually makes it scrollable.
  useEffect(() => {
    const el = segmentsTrackRef.current
    if (!el || !editorOpen) return
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) setTrackWidth(entry.contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [editorOpen])

  const pps = trackWidth ? Math.max(MIN_PPS, trackWidth / tlTotal) : 0
  useEffect(() => { ppsRef.current = pps || MIN_PPS }, [pps])
  const trackPxWidth = pps ? tlTotal * pps : 0
  const rulerTicks = useMemo(() => {
    if (!pps) return []
    let step = RULER_STEP_CANDIDATES[RULER_STEP_CANDIDATES.length - 1]
    for (const candidate of RULER_STEP_CANDIDATES) {
      if (candidate * pps >= 64) { step = candidate; break }
    }
    const ticks = []
    for (let t = 0; t <= tlTotal + 0.001; t += step) ticks.push(t)
    return ticks
  }, [pps, tlTotal])

  const activeSeg = segments[selectedSegment]
  const activeRawClip = activeSeg ? clips[activeSeg.clipRef] : clips[0]
  const availableCamera = activeRawClip?.cameras[camera] ? camera : CAMERA_ORDER.find(key => activeRawClip?.cameras[key])
  const source = activeRawClip?.cameras[availableCamera]

  const resolveSegPath = seg => {
    const rawClip = clips[seg?.clipRef]
    if (!rawClip) return null
    const cam = rawClip.cameras[camera] ? camera : CAMERA_ORDER.find(key => rawClip.cameras[key])
    return rawClip.cameras[cam]?.path || null
  }

  // Reset editor state when a different event is selected, and pick a sensible
  // starting camera (prefer the one that actually triggered the event).
  useEffect(() => {
    setSegments([])
    setSelectedSegment(0)
    setPlaying(false)
    setTime(0)
    setDuration(0)
    setCrop('original')
    setVideoError(null)
    setHistory([])
    continuePlaying.current = false
    if (!selected) return
    const refClip = clips[selected.event_segment_index || 0] || clips[0]
    if (selected.event_camera && refClip?.cameras[selected.event_camera]) setCamera(selected.event_camera)
    else if (!refClip?.cameras[camera]) setCamera(CAMERA_ORDER.find(key => refClip?.cameras[key]) || 'front')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id])

  // Tesla stores every minute belonging to one incident as separate files.
  // Probe each one's real duration and lay them end-to-end as one combined,
  // scrubbable timeline instead of only ever loading the first minute.
  useEffect(() => {
    if (!selected || !clips.length || !library.media_token) return
    let cancelled = false
    ;(async () => {
      let pos = 0
      for (let i = 0; i < clips.length; i++) {
        if (cancelled) break
        const clip = clips[i]
        const cam = clip.cameras[camera] ? camera : CAMERA_ORDER.find(key => clip.cameras[key])
        const path = clip.cameras[cam]?.path
        let dur = FALLBACK_CLIP_DURATION
        if (path && probeVideoRef.current) {
          try { dur = await probeDuration(probeVideoRef.current, path, library.media_token) } catch { /* use fallback estimate */ }
        }
        if (cancelled) break
        const segPos = pos
        setSegments(current => [...current, { clipRef: i, start: 0, end: dur, max: dur, pos: segPos }])
        pos += dur
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, library.media_token])

  useEffect(() => { setVideoError(null); setVideoLoading(!!source?.path) }, [source?.path])

  // Streamed vehicle telemetry only covers however far back MQTT retention
  // goes — older footage simply won't have matching samples.
  useEffect(() => {
    setTelemetry([])
    if (!clips.length) return
    const stamps = clips.map(c => stampDate(c.timestamp).getTime()).filter(Number.isFinite)
    if (!stamps.length) return
    const startMs = Math.min(...stamps) - 5000
    const endMs = Math.max(...stamps) + (FALLBACK_CLIP_DURATION + 30) * 1000
    let cancelled = false
    fetchTelemetryRange(new Date(startMs).toISOString(), new Date(endMs).toISOString())
      .then(rows => { if (!cancelled) setTelemetry(rows) })
      .catch(() => { if (!cancelled) setTelemetry([]) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id])

  useEffect(() => {
    if (!editorOpen || !library.media_token) return
    const withPaths = segments.map(seg => ({ seg, path: resolveSegPath(seg) })).filter(x => x.path)
    const pending = withPaths.filter(({ seg, path }) => !frameCache[segmentFrameKey(path, seg)])
    if (!pending.length || thumbBusy.current) return
    thumbBusy.current = true
    let cancelled = false
    ;(async () => {
      for (const { seg, path } of pending) {
        if (cancelled) break
        try {
          const frames = await captureSegmentFrames(thumbVideoRef.current, { path, start: seg.start, end: seg.end }, library.media_token)
          if (!cancelled) setFrameCache(cache => ({ ...cache, [segmentFrameKey(path, seg)]: frames }))
        } catch { /* leave uncached; shimmer placeholder stays */ }
      }
      thumbBusy.current = false
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorOpen, segments, library.media_token, camera])

  const chooseCamera = key => {
    if (!activeRawClip?.cameras[key] || key === availableCamera) return
    pendingTime.current = videoRef.current?.currentTime ?? time
    setCamera(key)
    setPlaying(false)
  }

  const onMetadata = event => {
    const length = Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0
    setDuration(length)
    event.currentTarget.currentTime = Math.min(pendingTime.current, length || 0)
    pendingTime.current = 0
    setTime(event.currentTarget.currentTime)
    event.currentTarget.playbackRate = rate
    if (continuePlaying.current) {
      continuePlaying.current = false
      event.currentTarget.play().catch(() => {})
    }
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

  // Load a specific timeline segment into the preview player, at an optional
  // offset from that segment's own in-point. Switches source files (and waits
  // for the new file to load) whenever the target segment isn't already loaded.
  // `resume` keeps playback going across the switch (used when advancing
  // during playback, as opposed to a manual click/scrub which just seeks).
  const goToSegment = (index, offsetSeconds = 0, resume = false) => {
    const seg = segments[index]
    if (!seg) return
    const targetPath = resolveSegPath(seg)
    const targetTime = seg.start + Math.max(0, Math.min(offsetSeconds, clipLength(seg)))
    if (targetPath && targetPath === source?.path) {
      seek(targetTime)
      if (resume && videoRef.current) videoRef.current.play().then(() => setPlaying(true)).catch(() => {})
    } else {
      pendingTime.current = targetTime
      continuePlaying.current = resume
    }
    setSelectedSegment(index)
  }

  const jumpToEvent = () => {
    if (!selected?.is_event) return
    const targetIndex = segments.findIndex(seg => seg.clipRef === (selected.event_segment_index || 0))
    if (targetIndex >= 0) goToSegment(targetIndex, selected.event_offset || 0)
  }

  // Segments can be freely repositioned, so "next clip" means whichever comes
  // next by timeline position — not the next array index, and not "wherever
  // the underlying file happens to end" (two segments can share one file with
  // different start/end sub-ranges, and the native <video> has no idea where
  // our virtual cut points are).
  const orderedSegmentIndices = useMemo(
    () => segments.map((_, i) => i).sort((a, b) => segments[a].pos - segments[b].pos),
    [segments]
  )

  const advanceToNextSegment = () => {
    const order = orderedSegmentIndices.indexOf(selectedSegment)
    const nextIndex = order >= 0 && order < orderedSegmentIndices.length - 1 ? orderedSegmentIndices[order + 1] : null
    if (nextIndex == null) {
      videoRef.current?.pause()
      setPlaying(false)
      return
    }
    goToSegment(nextIndex, 0, true)
  }

  // The native `ended` event only fires at the underlying file's true end,
  // which is meaningless once segments carve a file into sub-ranges — watch
  // playback and cut over as soon as we cross the *active segment's* own end.
  const handleTimeUpdate = event => {
    const t = event.currentTarget.currentTime
    setTime(t)
    if (playing && activeSeg && t >= activeSeg.end - 0.05) {
      event.currentTarget.pause()
      advanceToNextSegment()
    }
  }

  const changeRate = value => {
    const next = Number(value)
    setRate(next)
    if (videoRef.current) videoRef.current.playbackRate = next
  }

  const pushHistory = () => setHistory(current => [...current.slice(-49), { segments, selectedSegment }])

  const undo = () => {
    if (!history.length) return
    const prev = history[history.length - 1]
    setHistory(current => current.slice(0, -1))
    setSegments(prev.segments)
    setSelectedSegment(prev.selectedSegment)
  }

  const patchSegment = (index, values) => setSegments(current => current.map((segment, i) => i === index ? { ...segment, ...values } : segment))

  const splitSegment = () => {
    const segment = segments[selectedSegment]
    if (!segment || time <= segment.start + 0.1 || time >= segment.end - 0.1) {
      setMessage('Move the playhead inside the selected clip to split it.')
      return
    }
    const splitPos = segment.pos + (time - segment.start)
    pushHistory()
    setSegments(current => [
      ...current.slice(0, selectedSegment),
      { ...segment, end: time },
      { ...segment, start: time, pos: splitPos },
      ...current.slice(selectedSegment + 1),
    ])
    setSelectedSegment(selectedSegment + 1)
    setMessage('')
  }

  const removeSegment = index => {
    if (segments.length === 1) return
    pushHistory()
    setSegments(current => current.filter((_, i) => i !== index))
    setSelectedSegment(Math.max(0, Math.min(index - 1, segments.length - 2)))
  }

  const nudgeSegment = (index, deltaSeconds) => {
    pushHistory()
    setSegments(current => current.map((seg, i) => i === index ? { ...seg, pos: Math.max(0, seg.pos + deltaSeconds) } : seg))
  }

  const duplicateSegment = () => {
    const segment = segments[selectedSegment]
    if (!segment) return
    pushHistory()
    setSegments(current => [...current.slice(0, selectedSegment + 1), { ...segment, pos: segment.pos + clipLength(segment) }, ...current.slice(selectedSegment + 1)])
    setSelectedSegment(selectedSegment + 1)
  }

  // Click/drag anywhere on the ruler or the empty timeline background scrubs
  // the combined edit timeline, switching source clips as needed. Landing in
  // a gap snaps to the nearest clip edge.
  const scrubToEditTime = editTarget => {
    const covering = segments.find(seg => editTarget >= seg.pos - 0.001 && editTarget <= seg.pos + clipLength(seg) + 0.001)
    if (covering) { goToSegment(segments.indexOf(covering), editTarget - covering.pos); return }
    let bestIndex = -1, bestOffset = 0, bestDist = Infinity
    segments.forEach((seg, i) => {
      const startDist = Math.abs(editTarget - seg.pos)
      const endDist = Math.abs(editTarget - (seg.pos + clipLength(seg)))
      if (startDist < bestDist) { bestDist = startDist; bestOffset = 0; bestIndex = i }
      if (endDist < bestDist) { bestDist = endDist; bestOffset = clipLength(seg); bestIndex = i }
    })
    if (bestIndex >= 0) goToSegment(bestIndex, bestOffset)
  }

  const startScrub = event => {
    event.preventDefault()
    // currentTarget is the pixel-width inner ruler/segments element, so its
    // own bounding rect already reflects however far the track has scrolled.
    const container = event.currentTarget
    const scrub = clientX => {
      const rect = container.getBoundingClientRect()
      const editTarget = Math.max(0, Math.min((clientX - rect.left) / (ppsRef.current || MIN_PPS), tlTotalRef.current))
      scrubToEditTime(editTarget)
    }
    if (playing) togglePlay()
    scrub(event.clientX)
    const move = ev => scrub(ev.clientX)
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up) }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  // Drag either edge of the selected clip to trim it. Shortening from the
  // left keeps the clip's right edge anchored on the timeline (its position
  // moves forward, opening a gap); shortening from the right just pulls the
  // right edge in. The clip's own probed length caps how far it can re-extend.
  const startTrim = (index, edge) => event => {
    event.preventDefault()
    event.stopPropagation()
    setSelectedSegment(index)
    pushHistory()
    let lastX = event.clientX
    const move = ev => {
      const pxPerSec = ppsRef.current || MIN_PPS
      const dSec = (ev.clientX - lastX) / pxPerSec
      lastX = ev.clientX
      setSegments(current => current.map((seg, i) => {
        if (i !== index) return seg
        if (edge === 'start') {
          const newStart = Math.max(0, Math.min(seg.start + dSec, seg.end - 0.2))
          return { ...seg, start: newStart, pos: Math.max(0, seg.pos + (newStart - seg.start)) }
        }
        const newEnd = Math.min(seg.max, Math.max(seg.end + dSec, seg.start + 0.2))
        return { ...seg, end: newEnd }
      }))
    }
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up) }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  // Drag a clip's body to move it freely along the timeline — no swapping,
  // no snapping to neighbors, it can pass over or land anywhere (including
  // gaps or overlaps). Only the clip's `pos` changes; export sorts by pos.
  const startMove = index => event => {
    if (event.target.closest('.dashcam-seg-handle')) return
    const startClientX = event.clientX
    let dragging = false
    let lastX = startClientX
    const move = ev => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startClientX) < 4) return
        dragging = true
        pushHistory()
        setSelectedSegment(index)
      }
      ev.preventDefault()
      const pxPerSec = ppsRef.current || MIN_PPS
      const dSec = (ev.clientX - lastX) / pxPerSec
      lastX = ev.clientX
      setSegments(current => current.map((seg, i) => i === index ? { ...seg, pos: Math.max(0, seg.pos + dSec) } : seg))
    }
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up) }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  const uploadFolder = async event => {
    const files = Array.from(event.target.files).filter(file => CLIP_RE.test(file.name) || METADATA_RE.test(file.name))
    event.target.value = ''
    if (!files.length) { setMessage('No TeslaCam MP4 files were found in that folder.'); return }
    setMessage('')
    try {
      const paths = files.map(file => file.webkitRelativePath || file.name)
      const { existing } = await fetchExistingDashcamFiles(files.map((file, index) => ({ path: paths[index], bytes: file.size })))
      const existingPaths = new Set(existing)
      const pending = files.filter((file, index) => !existingPaths.has(paths[index]))
      const total = pending.reduce((sum, file) => sum + file.size, 0)
      let completed = 0
      if (pending.length) setUpload({ done: 0, count: pending.length, total })
      for (const file of pending) {
        const path = file.webkitRelativePath || file.name
        await uploadDashcamFile(file, path, loaded => setUpload({ done: completed + loaded, count: pending.length, total }))
        completed += file.size
      }
      await refreshLibrary(false)
      const skipped = files.length - pending.length
      setMessage(`${pending.length} camera file${pending.length === 1 ? '' : 's'} added; ${skipped} unchanged file${skipped === 1 ? '' : 's'} skipped.`)
    } catch (error) {
      setMessage(error.message)
    } finally { setUpload(null) }
  }

  const exportEdit = async () => {
    const ordered = segments
      .slice()
      .sort((a, b) => a.pos - b.pos)
      .map(seg => ({ path: resolveSegPath(seg), start: seg.start, end: seg.end }))
      .filter(seg => seg.path)
    if (!ordered.length) return
    setExporting(true)
    setMessage('Rendering your edit…')
    try {
      const blob = await exportDashcamEdit(ordered, crop)
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

  const editTime = activeSeg ? activeSeg.pos + (time - activeSeg.start) : null
  const wallClockMs = activeRawClip ? stampDate(activeRawClip.timestamp).getTime() + time * 1000 : null
  const telemetrySpeed = useMemo(() => telemetry.filter(p => p.speed != null), [telemetry])
  const telemetryBrake = useMemo(() => telemetry.filter(p => p.brake_pedal != null), [telemetry])
  const speedSample = nearestTelemetrySample(telemetrySpeed, wallClockMs)
  const brakeSample = nearestTelemetrySample(telemetryBrake, wallClockMs)

  return (
    <section className={`dashcam ${editorOpen ? 'dashcam-editing' : ''}`}>
      <video ref={probeVideoRef} muted preload="metadata" style={{ display: 'none' }} />
      <div className="dashcam-heading">
        <div>
          <div className="dashcam-eyebrow">TeslaCam Studio</div>
          <p>{library.events.length} events · {formatBytes(library.total_bytes)} · originals untouched</p>
          {storage.max_bytes ? (
            <div className="dashcam-storage" title="Recent/Sentry footage is pruned oldest-first once this fills; Saved clips are never auto-deleted.">
              <div><span style={{ width: `${Math.min(100, storage.used_bytes / storage.max_bytes * 100)}%` }} /></div>
              <small>{formatBytes(storage.used_bytes)} of {formatBytes(storage.max_bytes)} used</small>
            </div>
          ) : null}
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
            <div className="dashcam-list" ref={libraryListRef}>
              {filtered.map(event => <div key={event.id} className={`dashcam-event ${selected?.id === event.id ? 'active' : ''} ${deleteConfirm === event.id ? 'confirming' : ''}`}>
                <button className="dashcam-event-main" onClick={() => { setSelectedId(event.id); setDeleteConfirm(null) }}>
                  <span className="dashcam-thumb">{event.thumbnail ? <img loading="lazy" src={dashcamMediaUrl(event.thumbnail, library.media_token)} alt="" /> : <span>{CAMERAS[Object.keys(event.cameras)[0]]?.icon || '▶'}</span>}<i className={`type-${event.type.toLowerCase()}`} /></span>
                  <span className="dashcam-event-copy"><strong>{formatStamp(event.timestamp)}</strong><small>{event.event_label || event.type} · {Object.keys(event.cameras).length} angles{event.segments?.length > 1 ? ` · ${event.segments.length} clips` : ''}</small><small>{formatBytes(event.bytes)}</small></span>
                </button>
                <button className="dashcam-event-delete" disabled={deleting === event.id} onClick={() => removeEvent(event)} title={deleteConfirm === event.id ? 'Click again to permanently delete' : 'Delete clip'}>{deleting === event.id ? '…' : deleteConfirm === event.id ? 'Delete?' : '×'}</button>
              </div>)}
              {!filtered.length && <div className="empty">No matching clips</div>}
            </div>
          </aside>

          <div className="dashcam-stage">
            {editorOpen && <div className="dashcam-editor-topbar"><div><strong>TeslaCam Studio</strong><span>{formatStamp(selected.timestamp)} · {CAMERAS[availableCamera]?.name}</span></div><button onClick={() => setEditorOpen(false)}>Done</button></div>}
            <div className={`dashcam-video-frame crop-${crop.replace(':', '-')}`}>
              <video
                key={source?.path}
                ref={videoRef}
                src={source ? dashcamMediaUrl(source.path, library.media_token) : ''}
                playsInline muted preload="auto"
                onLoadedMetadata={onMetadata}
                onTimeUpdate={handleTimeUpdate}
                onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
                onEnded={advanceToNextSegment} onClick={togglePlay}
                onLoadedData={() => setVideoLoading(false)}
                onError={() => { setVideoLoading(false); setVideoError(`Couldn't load ${CAMERAS[availableCamera]?.name || 'this'} camera footage — the clip may be corrupt or in an unsupported format.`) }}
              />
              {videoLoading && !videoError && <span className="dashcam-video-loading-bar" />}
              {videoError && <div className="dashcam-video-error"><strong>{CAMERAS[availableCamera]?.name} camera unavailable</strong><span>{videoError}</span></div>}
              {videoLoading && !videoError && <div className="dashcam-video-loading-spinner" aria-label="Loading video" />}
              {!playing && !videoError && !videoLoading && <button className="dashcam-center-play" onClick={togglePlay}>▶</button>}
              <span className="dashcam-camera-label">
                {CAMERAS[availableCamera]?.name}
                {clips.length > 1 && (() => {
                  const order = orderedSegmentIndices.indexOf(selectedSegment)
                  const prevIndex = order > 0 ? orderedSegmentIndices[order - 1] : null
                  const nextIndex = order >= 0 && order < orderedSegmentIndices.length - 1 ? orderedSegmentIndices[order + 1] : null
                  return (
                    <span className="dashcam-clip-nav">
                      <button disabled={prevIndex == null} onClick={e => { e.stopPropagation(); goToSegment(prevIndex, 0) }}>‹</button>
                      {`Clip ${(activeSeg?.clipRef ?? 0) + 1}/${clips.length}`}
                      <button disabled={nextIndex == null} onClick={e => { e.stopPropagation(); goToSegment(nextIndex, 0) }}>›</button>
                    </span>
                  )
                })()}
              </span>
              {selected.is_event && activeSeg?.clipRef === (selected.event_segment_index || 0) && <span className="dashcam-event-badge">● {selected.event_label} at {formatTime(selected.event_offset)}</span>}
              {(speedSample || brakeSample) && (
                <span className="dashcam-telemetry">
                  {speedSample && <strong>{Math.round(speedSample.speed)} mph</strong>}
                  {brakeSample && <span className={`dashcam-brake-pill ${isBrakeActive(brakeSample.brake_pedal) ? 'active' : ''}`}><i className="dashcam-brake-dot" />Brake</span>}
                </span>
              )}
              <span className="dashcam-video-progress" style={{ width: `${duration ? time / duration * 100 : 0}%` }} />

              <div className="dashcam-stage-head">
                <div><span className={`dashcam-type type-${selected.type.toLowerCase()}`}>{selected.event_label || selected.type}</span><strong>{formatStamp(selected.timestamp)}</strong></div>
                <div className="dashcam-stage-actions">{selected.is_event && <button onClick={jumpToEvent}>Jump to event · {formatTime(selected.event_offset)}</button>}<button className={editorOpen ? 'active' : ''} onClick={() => setEditorOpen(value => !value)}>{editorOpen ? 'Close editor' : 'Open editor'}</button></div>
              </div>

              <div className="dashcam-angle-picker">
                {CAMERA_ORDER.map(key => <button key={key} disabled={!activeRawClip?.cameras[key]} className={availableCamera === key ? 'active' : ''} onClick={() => chooseCamera(key)}>
                  <span>{CAMERAS[key].icon}</span><strong>{CAMERAS[key].name}</strong><small>{activeRawClip?.cameras[key] ? 'Available' : 'Missing'}</small>
                </button>)}
              </div>

              <div className="dashcam-transport">
                <button className="dashcam-play" onClick={togglePlay}>{playing ? 'Ⅱ' : '▶'}</button>
                <span>{formatTime(time)}</span>
                <input type="range" min="0" max={duration || 1} step="0.04" value={Math.min(time, duration || 0)} onChange={e => seek(e.target.value)} />
                <span>{formatTime(duration)}</span>
                <div className="dashcam-rates">{[.5, 1, 1.5, 2].map(value => <button key={value} className={rate === value ? 'active' : ''} onClick={() => changeRate(value)}>{value}×</button>)}</div>
              </div>
            </div>

            {editorOpen && <div className="dashcam-editor">
              <div className="dashcam-editor-head"><div className="dashcam-editor-actions"><button disabled={!history.length} onClick={undo}><UndoIcon />Undo</button><button onClick={splitSegment}><SplitIcon />Split</button><button onClick={duplicateSegment}><DuplicateIcon />Duplicate</button><button className="danger" disabled={segments.length === 1} onClick={() => removeSegment(selectedSegment)}><DeleteIcon />Delete</button></div><div className="dashcam-editor-clock"><strong><i>{formatTime(time)}</i> / {formatTime(duration)}</strong><span>Timeline</span></div></div>
              <div className="dashcam-timeline-scroll" ref={segmentsTrackRef}>
                <div className="dashcam-timeline-track" style={{ width: trackPxWidth || '100%' }}>
                  <div className="dashcam-timeline-ruler" onPointerDown={startScrub}>
                    {rulerTicks.map(t => <span key={t} style={{ left: t * pps }}>{formatTime(t)}</span>)}
                  </div>
                  <div className="dashcam-segments" onPointerDown={e => { if (e.target === e.currentTarget) startScrub(e) }}>
                    <video ref={thumbVideoRef} muted playsInline preload="metadata" style={{ position: 'fixed', left: '-9999px', top: 0, width: '2px', height: '2px', opacity: 0, pointerEvents: 'none' }} />
                    {segments.map((segment, index) => {
                      const path = resolveSegPath(segment)
                      const frames = path ? frameCache[segmentFrameKey(path, segment)] : null
                      return (
                        <button
                          key={index}
                          data-seg-index={index}
                          style={{ left: segment.pos * pps, width: clipLength(segment) * pps }}
                          className={selectedSegment === index ? 'active' : ''}
                          onClick={() => goToSegment(index, 0)}
                          onPointerDown={startMove(index)}
                        >
                          <span className="dashcam-seg-frames">
                            {frames
                              ? frames.map((frame, frameIndex) => frame ? <img key={frameIndex} src={frame} alt="" /> : <span key={frameIndex} className="dashcam-seg-frames-loading" />)
                              : <span className="dashcam-seg-frames-loading" />}
                          </span>
                          <span className="dashcam-seg-overlay" />
                          <span className="dashcam-seg-tag">{clips.length > 1 ? `Clip ${segment.clipRef + 1} · ` : ''}{formatTime(segment.start)}–{formatTime(segment.end)}</span>
                          <span className="dashcam-seg-handle dashcam-seg-handle-l" onPointerDown={startTrim(index, 'start')}><i /><i /></span>
                          <span className="dashcam-seg-handle dashcam-seg-handle-r" onPointerDown={startTrim(index, 'end')}><i /><i /></span>
                        </button>
                      )
                    })}
                    {editTime != null && <i className="dashcam-playhead" style={{ left: editTime * pps }} />}
                  </div>
                </div>
              </div>
              {segments[selectedSegment] && <div className="dashcam-edit-tools">
                <label>In <input type="number" min="0" max={segments[selectedSegment].end - 0.1} step="0.1" value={segments[selectedSegment].start.toFixed(1)} onChange={e => { pushHistory(); patchSegment(selectedSegment, { start: Math.min(Number(e.target.value), segments[selectedSegment].end - 0.1) }) }} /></label>
                <button onClick={() => { pushHistory(); patchSegment(selectedSegment, { start: Math.min(time, segments[selectedSegment].end - .1) }) }}>Set in</button>
                <label>Out <input type="number" min={segments[selectedSegment].start + 0.1} max={segments[selectedSegment].max} step="0.1" value={segments[selectedSegment].end.toFixed(1)} onChange={e => { pushHistory(); patchSegment(selectedSegment, { end: Math.max(Number(e.target.value), segments[selectedSegment].start + 0.1) }) }} /></label>
                <button onClick={() => { pushHistory(); patchSegment(selectedSegment, { end: Math.max(time, segments[selectedSegment].start + .1) }) }}>Set out</button>
                <button title="Nudge earlier" onClick={() => nudgeSegment(selectedSegment, -1)}>←</button>
                <button title="Nudge later" onClick={() => nudgeSegment(selectedSegment, 1)}>→</button>
              </div>}
              <div className="dashcam-export-row">
                <div className="dashcam-crop"><span>Crop</span>{['original', '16:9', '1:1', '9:16'].map(value => <button key={value} className={crop === value ? 'active' : ''} onClick={() => setCrop(value)}>{value === 'original' ? 'Original' : value}</button>)}</div>
                <div className="dashcam-export-summary"><span>{segments.length} clip{segments.length !== 1 ? 's' : ''} · {formatTime(segments.reduce((sum, s) => sum + clipLength(s), 0))}</span><button disabled={exporting || !segments.length} onClick={exportEdit}>{exporting ? 'Rendering…' : <><ExportIcon />Export edit</>}</button></div>
              </div>
            </div>}
          </div>
        </div>
      ) : null}
    </section>
  )
}
