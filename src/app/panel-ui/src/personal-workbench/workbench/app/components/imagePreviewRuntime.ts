import type { DocumentPreview } from '../../../../../../panel-api/workbench'

const MAX_CACHED_IMAGES = 16
const MAX_CACHED_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_IMAGE_CACHE_BYTES = 48 * 1024 * 1024

type CachedImage = {
  readonly objectUrl: string
  readonly byteLength: number
  readonly decodedImage: HTMLImageElement
}

const imageCache = new Map<string, CachedImage>()
const imageLoads = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()
let cachedImageBytes = 0

export function prefetchImagePreview(preview: DocumentPreview): void {
  if (preview.content.kind !== 'media' || preview.content.mediaKind !== 'image') return
  void warmImagePreview(preview.content.url, preview.fingerprint, preview.byteLength)
}

export function warmImagePreview(url: string, sourceVersion?: string, byteLength?: number): Promise<void> {
  const key = imageCacheKey(url, sourceVersion)
  if (imageCache.has(key)) return Promise.resolve()
  const activeLoad = imageLoads.get(key)
  if (activeLoad !== undefined) return activeLoad
  if (byteLength !== undefined && byteLength > MAX_CACHED_IMAGE_BYTES) {
    warmUncachedImage(url)
    return Promise.resolve()
  }

  const request = fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error(`Image preload failed (${response.status}).`)
      return response.blob()
    })
    .then(async (blob) => {
      if (blob.size > MAX_CACHED_IMAGE_BYTES) {
        warmUncachedImage(url)
        return
      }
      const objectUrl = URL.createObjectURL(blob)
      const decodedImage = new Image()
      decodedImage.decoding = 'sync'
      decodedImage.src = objectUrl
      try {
        if (decodedImage.decode !== undefined) await decodedImage.decode()
        storeImage(key, { objectUrl, byteLength: blob.size, decodedImage })
      } catch {
        URL.revokeObjectURL(objectUrl)
      }
    })
    .catch(() => warmUncachedImage(url))
    .finally(() => imageLoads.delete(key))
  imageLoads.set(key, request)
  return request
}

export function getWarmedImageUrl(url: string, sourceVersion?: string): string | undefined {
  const key = imageCacheKey(url, sourceVersion)
  const cached = imageCache.get(key)
  if (cached === undefined) return undefined
  imageCache.delete(key)
  imageCache.set(key, cached)
  return cached.objectUrl
}

export function subscribeImagePreview(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function storeImage(key: string, image: CachedImage): void {
  const existing = imageCache.get(key)
  if (existing !== undefined) {
    cachedImageBytes -= existing.byteLength
    URL.revokeObjectURL(existing.objectUrl)
  }
  imageCache.delete(key)
  imageCache.set(key, image)
  cachedImageBytes += image.byteLength
  while (imageCache.size > MAX_CACHED_IMAGES || cachedImageBytes > MAX_IMAGE_CACHE_BYTES) {
    const oldestKey = imageCache.keys().next().value
    if (oldestKey === undefined) break
    const oldest = imageCache.get(oldestKey)!
    imageCache.delete(oldestKey)
    cachedImageBytes -= oldest.byteLength
    URL.revokeObjectURL(oldest.objectUrl)
  }
  listeners.forEach((listener) => listener())
}

function warmUncachedImage(url: string): void {
  const image = new Image()
  image.decoding = 'async'
  image.src = url
}

function imageCacheKey(url: string, sourceVersion?: string): string {
  return `${url}\u0000${sourceVersion ?? ''}`
}
