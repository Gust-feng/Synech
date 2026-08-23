import type { DocumentPreview } from '../../../../../../panel-api-contracts'

const MAX_CACHED_VIDEO_POSTERS = 12
const MAX_POSTER_WIDTH = 960
const FIRST_FRAME_TIMEOUT_MS = 8_000

const posterCache = new Map<string, string>()
const posterLoads = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

export function prefetchVideoPreview(preview: DocumentPreview): void {
  if (preview.content.kind !== 'media' || preview.content.mediaKind !== 'video') return
  warmVideoPreview(preview.content.url, preview.content.poster, preview.fingerprint)
}

export function warmVideoPreview(url: string, fallbackPoster?: string, sourceVersion?: string): void {
  if (fallbackPoster !== undefined) {
    const image = new Image()
    image.decoding = 'async'
    image.src = fallbackPoster
    return
  }
  const key = videoPreviewKey(url, sourceVersion)
  if (posterCache.has(key) || posterLoads.has(key)) return

  const load = captureFirstVideoFrame(url, key).finally(() => posterLoads.delete(key))
  posterLoads.set(key, load)
}

export function getWarmedVideoPoster(url: string, sourceVersion?: string): string | undefined {
  const key = videoPreviewKey(url, sourceVersion)
  const poster = posterCache.get(key)
  if (poster !== undefined) {
    posterCache.delete(key)
    posterCache.set(key, poster)
  }
  return poster
}

export function subscribeVideoPreviewPoster(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function captureFirstVideoFrame(url: string, key: string): Promise<void> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    let completed = false
    let frameCallback: number | undefined
    const timeout = window.setTimeout(finish, FIRST_FRAME_TIMEOUT_MS)
    const fail = () => finish()

    function cleanup() {
      window.clearTimeout(timeout)
      video.removeEventListener('loadedmetadata', requestFirstFrame)
      video.removeEventListener('loadeddata', capture)
      video.removeEventListener('error', fail)
      if (frameCallback !== undefined) video.cancelVideoFrameCallback?.(frameCallback)
      video.pause()
      video.remove()
      video.removeAttribute('src')
      video.load()
    }

    function finish(poster?: string) {
      if (completed) return
      completed = true
      cleanup()
      if (poster === undefined) {
        resolve()
        return
      }
      warmPosterImage(poster).finally(() => {
        storePoster(key, poster)
        resolve()
      })
    }

    function requestFirstFrame() {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        capture()
        return
      }
      if (video.requestVideoFrameCallback !== undefined) {
        frameCallback = video.requestVideoFrameCallback(capture)
      }
      void video.play().catch(() => {
        try {
          video.currentTime = 0.001
        } catch {
          finish()
        }
      })
    }

    function capture() {
      if (completed) return
      const poster = capturePoster(video)
      finish(poster)
    }

    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.setAttribute('aria-hidden', 'true')
    Object.assign(video.style, {
      position: 'fixed',
      width: '1px',
      height: '1px',
      left: '0',
      bottom: '0',
      opacity: '0',
      pointerEvents: 'none',
    })
    video.addEventListener('loadedmetadata', requestFirstFrame)
    video.addEventListener('loadeddata', capture)
    video.addEventListener('error', fail)
    document.body.append(video)
    video.src = url
    video.load()
  })
}

async function warmPosterImage(poster: string): Promise<void> {
  const image = new Image()
  image.decoding = 'sync'
  image.src = poster
  if (image.decode === undefined) return
  try {
    await image.decode()
  } catch {
    // The data URL is still usable; decoding can retry when the poster is painted.
  }
}

function capturePoster(video: HTMLVideoElement): string | undefined {
  if (video.videoWidth <= 0 || video.videoHeight <= 0) return undefined
  const width = Math.min(video.videoWidth, MAX_POSTER_WIDTH)
  const height = Math.round((width / video.videoWidth) * video.videoHeight)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' } as CanvasRenderingContext2DSettings)
  if (context === null) return undefined
  try {
    context.drawImage(video, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', 0.84)
  } catch {
    return undefined
  }
}

function storePoster(key: string, poster: string): void {
  posterCache.delete(key)
  posterCache.set(key, poster)
  while (posterCache.size > MAX_CACHED_VIDEO_POSTERS) posterCache.delete(posterCache.keys().next().value!)
  listeners.forEach((listener) => listener())
}

function videoPreviewKey(url: string, sourceVersion?: string): string {
  return `${url}\u0000${sourceVersion ?? ''}`
}
