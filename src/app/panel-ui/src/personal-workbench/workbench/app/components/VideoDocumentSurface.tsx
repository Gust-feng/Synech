import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Film, Maximize2, Minimize2, Pause, Play, Volume2, VolumeX } from 'lucide-react'
import { getWarmedVideoPoster, subscribeVideoPreviewPoster, warmVideoPreview } from './videoPreviewRuntime'

type VideoDocumentSurfaceProps = {
  readonly url: string
  readonly title: string
  readonly poster?: string
  readonly duration?: string
  readonly sourceVersion?: string
}

type VideoSurfaceState = 'loading' | 'ready' | 'error'
type VideoSurfaceSnapshot = {
  readonly url: string
  readonly state: VideoSurfaceState
}

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

type PendingFirstFrame = {
  readonly video: FrameCallbackVideo
  readonly kind: 'video' | 'animation'
  readonly handle: number
}

export function VideoDocumentSurface({ url, title, poster, duration: durationLabel, sourceVersion }: VideoDocumentSurfaceProps) {
  const playerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const contextRef = useRef<CanvasRenderingContext2D | null>(null)
  const pendingFirstFrameRef = useRef<PendingFirstFrame | null>(null)
  const [surfaceSnapshot, setSurfaceSnapshot] = useState<VideoSurfaceSnapshot>({ url, state: 'loading' })
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [mediaDuration, setMediaDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const warmedPoster = useSyncExternalStore(
    subscribeVideoPreviewPoster,
    () => getWarmedVideoPoster(url, sourceVersion),
    () => undefined,
  )
  const visiblePoster = warmedPoster ?? poster
  const surfaceState = surfaceSnapshot.url === url ? surfaceSnapshot.state : 'loading'
  const visualState = surfaceState === 'loading' && visiblePoster !== undefined ? 'poster' : surfaceState
  const setSurfaceState = useCallback((state: VideoSurfaceState) => {
    setSurfaceSnapshot({ url, state })
  }, [url])

  useEffect(() => {
    warmVideoPreview(url, poster, sourceVersion)
  }, [poster, sourceVersion, url])

  const drawFrame = useCallback(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (video === null || canvas === null || video.videoWidth <= 0 || video.videoHeight <= 0) return false
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
    }
    contextRef.current ??= canvas.getContext('2d', {
      alpha: false,
      colorSpace: 'srgb',
    } as CanvasRenderingContext2DSettings)
    const context = contextRef.current
    if (context === null) return false
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    return true
  }, [])

  const cancelPendingFirstFrame = useCallback(() => {
    const pending = pendingFirstFrameRef.current
    if (pending === null) return
    if (pending.kind === 'video') pending.video.cancelVideoFrameCallback?.(pending.handle)
    else window.cancelAnimationFrame(pending.handle)
    pendingFirstFrameRef.current = null
  }, [])

  useEffect(() => {
    cancelPendingFirstFrame()
    setSurfaceState('loading')
    setPlaying(false)
    setCurrentTime(0)
    setMediaDuration(0)
    const canvas = canvasRef.current
    const context = contextRef.current
    if (canvas !== null && context !== null) context.clearRect(0, 0, canvas.width, canvas.height)
    contextRef.current = null
  }, [cancelPendingFirstFrame, setSurfaceState, url])

  useEffect(() => cancelPendingFirstFrame, [cancelPendingFirstFrame])

  useEffect(() => {
    const video = videoRef.current as FrameCallbackVideo | null
    if (!playing || video === null) return
    let disposed = false
    let frameHandle: number | undefined
    let animationHandle: number | undefined

    const schedule = () => {
      if (disposed) return
      if (video.requestVideoFrameCallback !== undefined) {
        frameHandle = video.requestVideoFrameCallback(render)
      } else {
        animationHandle = window.requestAnimationFrame(render)
      }
    }
    const render = () => {
      if (disposed) return
      drawFrame()
      if (!video.paused && !video.ended) schedule()
    }
    schedule()
    return () => {
      disposed = true
      if (frameHandle !== undefined) video.cancelVideoFrameCallback?.(frameHandle)
      if (animationHandle !== undefined) window.cancelAnimationFrame(animationHandle)
    }
  }, [drawFrame, playing])

  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(document.fullscreenElement === playerRef.current)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  const syncDuration = useCallback(() => {
    const value = videoRef.current?.duration ?? 0
    setMediaDuration(Number.isFinite(value) && value > 0 ? value : 0)
  }, [])

  const queueFirstFrame = useCallback(() => {
    const video = videoRef.current as FrameCallbackVideo | null
    if (video === null || surfaceState === 'ready' || pendingFirstFrameRef.current !== null) return
    if (drawFrame()) {
      setSurfaceState('ready')
      return
    }
    let pending: PendingFirstFrame
    const reveal = () => {
      if (pendingFirstFrameRef.current !== pending) return
      pendingFirstFrameRef.current = null
      if (drawFrame()) setSurfaceState('ready')
    }
    if (video.requestVideoFrameCallback !== undefined) {
      pending = { video, kind: 'video', handle: video.requestVideoFrameCallback(reveal) }
    } else {
      pending = { video, kind: 'animation', handle: window.requestAnimationFrame(reveal) }
    }
    pendingFirstFrameRef.current = pending
  }, [drawFrame, setSurfaceState, surfaceState])

  const failPlayback = useCallback(() => {
    cancelPendingFirstFrame()
    setSurfaceState('error')
    setPlaying(false)
  }, [cancelPendingFirstFrame, setSurfaceState])

  const togglePlayback = useCallback(async () => {
    const video = videoRef.current
    if (video === null || surfaceState === 'error') return
    if (!video.paused && !video.ended) {
      video.pause()
      return
    }
    if (video.ended) video.currentTime = 0
    try {
      await video.play()
    } catch {
      setPlaying(false)
    }
  }, [surfaceState])

  const seekTo = useCallback((value: number) => {
    const video = videoRef.current
    if (video === null || mediaDuration <= 0) return
    video.currentTime = Math.min(mediaDuration, Math.max(0, value))
    setCurrentTime(video.currentTime)
  }, [mediaDuration])

  const changeProgress = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    seekTo(Number(event.target.value))
  }, [seekTo])

  const changeVolume = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current
    if (video === null) return
    const nextVolume = Number(event.target.value)
    video.volume = nextVolume
    video.muted = false
    setVolume(nextVolume)
    setMuted(false)
  }, [])

  const toggleMute = useCallback(() => {
    const video = videoRef.current
    if (video === null) return
    if (video.muted || video.volume === 0) {
      if (video.volume === 0) video.volume = 0.7
      video.muted = false
    } else {
      video.muted = true
    }
    setVolume(video.volume)
    setMuted(video.muted)
  }, [])

  const toggleFullscreen = useCallback(async () => {
    const player = playerRef.current
    if (player === null) return
    try {
      if (document.fullscreenElement === player) await document.exitFullscreen()
      else await player.requestFullscreen()
    } catch {
      // Fullscreen can be denied by the host; playback remains usable.
    }
  }, [])

  const handleViewportKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (event.key.toLowerCase()) {
      case ' ':
      case 'k':
        event.preventDefault()
        void togglePlayback()
        break
      case 'arrowleft':
        event.preventDefault()
        seekTo(currentTime - 5)
        break
      case 'arrowright':
        event.preventDefault()
        seekTo(currentTime + 5)
        break
      case 'm':
        event.preventDefault()
        toggleMute()
        break
      case 'f':
        event.preventDefault()
        void toggleFullscreen()
        break
    }
  }, [currentTime, seekTo, toggleFullscreen, toggleMute, togglePlayback])

  const progressMax = mediaDuration > 0 ? mediaDuration : 1
  const progressValue = mediaDuration > 0 ? Math.min(currentTime, mediaDuration) : 0
  const resolvedDuration = mediaDuration > 0 ? formatVideoTime(mediaDuration) : durationLabel ?? '--:--'
  const volumeMuted = muted || volume === 0

  return (
    <div className="aa-video-document" data-document-scroll="content" data-state={visualState}>
      <div className="aa-video-document__stage">
        <div className="aa-video-document__player" ref={playerRef}>
          <div
            className="aa-video-document__viewport"
            role="button"
            tabIndex={0}
            aria-label={playing ? '暂停视频' : '播放视频'}
            onClick={() => void togglePlayback()}
            onDoubleClick={() => void toggleFullscreen()}
            onKeyDown={handleViewportKeyDown}
          >
            <canvas className="aa-video-document__canvas" role="img" aria-label={`${title} 画面`} ref={canvasRef} />
            <video
              className="aa-video-document__source"
              ref={videoRef}
              aria-hidden="true"
              tabIndex={-1}
              playsInline
              preload="auto"
              src={url}
              onLoadedMetadata={syncDuration}
              onDurationChange={syncDuration}
              onLoadedData={queueFirstFrame}
              onCanPlay={queueFirstFrame}
              onPlay={() => setPlaying(true)}
              onPause={() => { setPlaying(false); drawFrame() }}
              onEnded={(event) => { setPlaying(false); setCurrentTime(event.currentTarget.duration) }}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              onVolumeChange={(event) => { setVolume(event.currentTarget.volume); setMuted(event.currentTarget.muted) }}
              onSeeked={() => { drawFrame(); setCurrentTime(videoRef.current?.currentTime ?? 0) }}
              onError={failPlayback}
            />
            {visualState === 'poster' && (
              <img className="aa-video-document__poster" src={visiblePoster} alt="" />
            )}
            {surfaceState !== 'ready' && visualState !== 'poster' && (
              <div
                className="aa-video-document__placeholder"
                role={surfaceState === 'error' ? 'alert' : 'status'}
                aria-label={surfaceState === 'loading' ? '正在加载视频' : undefined}
              >
                <div className="aa-video-document__placeholder-content">
                  <span className="aa-video-document__placeholder-icon">
                    <Film size={22} aria-hidden="true" />
                  </span>
                  <strong>{surfaceState === 'loading' ? '正在准备视频预览' : '无法播放这个视频。'}</strong>
                  <span>{surfaceState === 'loading' ? title : '请检查视频文件后重新打开预览。'}</span>
                  {surfaceState === 'loading' && (
                    <span className="aa-video-document__placeholder-progress" aria-hidden="true">
                      <span />
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="aa-video-document__controls" role="group" aria-label="视频播放控件">
            <div className="aa-video-document__timeline">
              <progress max={progressMax} value={progressValue} aria-hidden="true" />
              <input
                type="range"
                aria-label="播放进度"
                min={0}
                max={progressMax}
                step="0.01"
                value={progressValue}
                disabled={surfaceState !== 'ready' || mediaDuration <= 0}
                onChange={changeProgress}
              />
            </div>
            <div className="aa-video-document__control-row">
              <button className="aa-video-document__control" type="button" aria-label={playing ? '暂停' : '播放'} disabled={surfaceState === 'error'} onClick={() => void togglePlayback()}>
                {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
              </button>
              <span className="aa-video-document__time">{formatVideoTime(currentTime)} / {resolvedDuration}</span>
              <span className="aa-video-document__control-spacer" />
              <button className="aa-video-document__control" type="button" aria-label={volumeMuted ? '取消静音' : '静音'} onClick={toggleMute}>
                {volumeMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
              </button>
              <input className="aa-video-document__volume" type="range" aria-label="音量" min={0} max={1} step="0.05" value={muted ? 0 : volume} onChange={changeVolume} />
              <button className="aa-video-document__control" type="button" aria-label={fullscreen ? '退出全屏' : '全屏'} onClick={() => void toggleFullscreen()}>
                {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function formatVideoTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0:00'
  const seconds = Math.floor(value)
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}