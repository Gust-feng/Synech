import { useEffect, useState, type ImgHTMLAttributes } from 'react'
import { ImageOff } from 'lucide-react'

export function ImageWithFallback({
  src,
  alt,
  className,
  style,
  onError,
  ...props
}: ImgHTMLAttributes<HTMLImageElement>) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [src])

  if (failed) {
    return (
      <span
        className={`inline-flex items-center justify-center ${className ?? ''}`}
        style={{ background: 'var(--aa-surface-hover, #eeebe6)', color: 'var(--aa-text-3, #aba39b)', ...style }}
        role="img"
        aria-label={alt || '图片加载失败'}
      >
        <ImageOff aria-hidden="true" size="35%" />
      </span>
    )
  }

  return (
    <img
      {...props}
      src={src}
      alt={alt}
      className={className}
      style={style}
      onError={(event) => {
        onError?.(event)
        if (!event.defaultPrevented) setFailed(true)
      }}
    />
  )
}