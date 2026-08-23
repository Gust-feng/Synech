/**
 * Shared Synech design language.
 *
 * One place for the decisions that must stay consistent across every view so
 * the workbench feels quiet, soft and coherent rather than pieced-together.
 *
 * Principles:
 *  - Corners stay in the 6–10px range (brief: 4–8px, +2 for large panels).
 *  - Elevation is expressed with hairline borders, not floaty shadows.
 *    Composers get the faintest lift so they read as "the place you type".
 *  - One neutral canvas everywhere; accent lavender is used sparingly.
 *  - Shared gutter + reading width so content lines up view to view.
 */

import type { CSSProperties } from 'react'

export const RADII = {
  sm: 6, // pills, small buttons
  md: 8, // list rows, inputs, small cards
  lg: 10, // composers, major panels
} as const

/** Horizontal gutter for view headers and content. */
export const GUTTER = 32

/** Height of every view's local header row, so chrome lines up. */
export const HEADER_H = 48

/** Reading column width for message / result streams. */
export const READING_WIDTH = 680

/** A tinted content card: quiet surface, hairline border, no shadow. */
export const contentCard: CSSProperties = {
  background: 'var(--aa-surface, #faf9f7)',
  border: '1px solid var(--aa-border, rgba(45,40,34,0.09))',
  borderRadius: RADII.lg,
}

/** The composer / input surface — the one element allowed a whisper of lift. */
export function composerSurface(focused = false): CSSProperties {
  return {
    background: 'var(--aa-composer, #ffffff)',
    border: `1px solid ${
      focused
        ? 'color-mix(in srgb, var(--aa-accent, #6865a7) 42%, var(--aa-border, rgba(45,40,34,0.09)))'
        : 'var(--aa-border, rgba(45,40,34,0.09))'
    }`,
    borderRadius: RADII.lg,
    boxShadow: focused
      ? 'var(--aa-composer-shadow-focus, 0 2px 12px rgba(45,40,34,0.05))'
      : 'var(--aa-composer-shadow, 0 1px 3px rgba(45,40,34,0.03))',
    transition: 'border-color 120ms ease, box-shadow 120ms ease',
  }
}
