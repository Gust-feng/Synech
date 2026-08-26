import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import type { WorkbenchView } from '../../../../workbench/navigation-state'
import { MOTION_EASING, MOTION_TIMING, useMotionEnabled } from '../../../../shell/motion-system'

export function WorkbenchViewTransition(props: {
  readonly view: WorkbenchView
  readonly children: ReactNode
}) {
  const motionEnabled = useMotionEnabled()
  return (
    <motion.div
      key={props.view}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      initial={motionEnabled ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: MOTION_TIMING.panel, ease: MOTION_EASING.premium }}
    >
      {props.children}
    </motion.div>
  )
}