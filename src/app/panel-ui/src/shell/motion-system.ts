import { useSyncExternalStore } from 'react'
import {
  getEffectiveMotionPreference,
  subscribeMotionSettingsChanged,
} from './motion'

export const MOTION_TIMING = {
  quick: 0.12,
  interaction: 0.18,
  panel: 0.28,
  spatial: 0.42,
} as const

export const MOTION_EASING = {
  standard: [0.2, 0, 0, 1] as const,
  premium: [0.22, 1, 0.36, 1] as const,
  exit: [0.4, 0, 1, 1] as const,
} as const

export function useMotionEnabled(): boolean {
  return useSyncExternalStore(
    subscribeMotionSettingsChanged,
    () => getEffectiveMotionPreference() === 'standard',
    () => true,
  )
}