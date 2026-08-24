import { useEffect, useState } from 'react'
import { AnimatePresence, motion, type Variants } from 'motion/react'
import { shouldUseMotion } from '../../../../shell/motion'
import { panelStorageKey } from '../../../../shell/local-preferences'
import type { HomeAmbientCopyPair } from './home-ambient-copy'

const AMBIENT_COPY_REVEALED_KEY = panelStorageKey('home.ambient-copy-revealed')
const AMBIENT_COPY_REVEAL_VERSION = 'whole-tail-presence-v1'
export const HOME_AMBIENT_COPY_INPUT_DELAY_MS = 260

const AMBIENT_TAIL_VARIANTS = {
  enter: {
    opacity: 0,
    left: 7,
    clipPath: 'inset(0 100% 0 0)',
  },
  visible: {
    opacity: 1,
    left: 0,
    clipPath: 'inset(0 0 0 0)',
    transition: {
      opacity: { duration: 0.22, ease: [0.16, 1, 0.3, 1] },
      left: { duration: 0.4, ease: [0.16, 1, 0.3, 1] },
      clipPath: { duration: 0.46, ease: [0.16, 1, 0.3, 1] },
    },
  },
  exit: {
    opacity: 0,
    left: -4,
    clipPath: 'inset(0 100% 0 0)',
    transition: {
      opacity: { duration: 0.14, delay: 0.16, ease: [0.4, 0, 1, 1] },
      left: { duration: 0.32, ease: [0.4, 0, 1, 1] },
      clipPath: { duration: 0.32, ease: [0.4, 0, 1, 1] },
    },
  },
} satisfies Variants

interface HomeAmbientCopyProps {
  copy: HomeAmbientCopyPair
  hasDraft: boolean
}

export function HomeAmbientCopy({ copy, hasDraft }: HomeAmbientCopyProps) {
  const [animate] = useState(shouldAnimateCopy)
  const [active, setActive] = useState(() => hasDraft && !shouldUseMotion())
  const idleCopy = `${copy.lead}${copy.idleTail}`
  const activeCopy = `${copy.lead}${copy.activeTail}`
  const motionEnabled = shouldUseMotion()

  useEffect(() => {
    if (!animate) return
    window.sessionStorage.setItem(AMBIENT_COPY_REVEALED_KEY, AMBIENT_COPY_REVEAL_VERSION)
  }, [animate])

  useEffect(() => {
    if (!hasDraft) {
      setActive(false)
      return
    }

    if (!shouldUseMotion()) {
      setActive(true)
      return
    }

    const timeout = window.setTimeout(() => setActive(true), HOME_AMBIENT_COPY_INPUT_DELAY_MS)
    return () => window.clearTimeout(timeout)
  }, [hasDraft])

  return (
    <p
      className="ui-agent-home__ambient"
      data-state={active ? 'active' : 'idle'}
      aria-label={active ? activeCopy : idleCopy}
    >
      <span className="ui-agent-home__ambient-reserve" aria-hidden="true">
        <span className="ui-agent-home__ambient-reserve-variant">{idleCopy}</span>
        <span className="ui-agent-home__ambient-reserve-variant">{activeCopy}</span>
      </span>
      <motion.span
        className={`ui-agent-home__ambient-copy${animate ? ' ui-agent-home__ambient-copy--entering' : ''}`}
        aria-hidden="true"
        initial={animate ? { opacity: 0, y: 8 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.46, ease: [0.16, 1, 0.3, 1] }}
      >
        <span className="ui-agent-home__ambient-lead">{copy.lead}</span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            className="ui-agent-home__ambient-tail"
            key={active ? 'active' : 'idle'}
            variants={AMBIENT_TAIL_VARIANTS}
            initial={motionEnabled ? 'enter' : false}
            animate="visible"
            exit={motionEnabled ? 'exit' : undefined}
          >
            {active ? copy.activeTail : copy.idleTail}
          </motion.span>
        </AnimatePresence>
      </motion.span>
    </p>
  )
}

function shouldAnimateCopy(): boolean {
  if (typeof window === 'undefined' || !shouldUseMotion()) return false
  return window.sessionStorage.getItem(AMBIENT_COPY_REVEALED_KEY) !== AMBIENT_COPY_REVEAL_VERSION
}
