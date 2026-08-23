import { shouldUseMotion } from '../../../../app-motion'

const TRANSITION_DURATION_MS = 320
const TRANSITION_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'

type FocusTransitionDirection = 'enter' | 'exit'

export interface FocusModeTransitionHandle {
  readonly cancel: () => void
}

interface FocusModeTransitionInput {
  readonly root: HTMLElement | null
  readonly direction: FocusTransitionDirection
  readonly update: () => void
}

interface ActiveTransition {
  readonly token: string
  readonly handle: FocusModeTransitionHandle
}

interface TransitionController {
  readonly handle: FocusModeTransitionHandle
  readonly finish: (commit: boolean) => void
  readonly setAnimations: (animations: readonly (Animation | undefined)[]) => void
  readonly start: () => void
}

const activeTransitions = new WeakMap<HTMLElement, ActiveTransition>()
let transitionSequence = 0

export function runFocusModeTransition(input: FocusModeTransitionInput): FocusModeTransitionHandle {
  const root = input.root
  const surface = root?.querySelector<HTMLElement>('.aa-conversation-surface') ?? null
  const main = root?.querySelector<HTMLElement>('.aa-workbench-main') ?? null

  if (root !== null) activeTransitions.get(root)?.handle.cancel()

  if (
    root === null
    || surface === null
    || main === null
    || !shouldUseMotion()
    || typeof surface.animate !== 'function'
  ) {
    input.update()
    return noOpHandle()
  }

  if (input.direction === 'enter') {
    return enterFocusMode(root, surface, input.update)
  }
  return exitFocusMode(root, surface, main, input.update)
}

function enterFocusMode(
  root: HTMLElement,
  surface: HTMLElement,
  update: () => void,
): FocusModeTransitionHandle {
  const initialSurfaceRect = surface.getBoundingClientRect()
  const initialContentRect = elementRect(surface, '.aa-conversation-scroll-content')
  const initialComposerRect = elementRect(surface, '.aa-conversation-composer-frame')
  const controller = createController(root, 'enter')
  update()

  const focusedSurface = root.querySelector<HTMLElement>('.aa-conversation-surface')
  if (focusedSurface === null) {
    controller.finish(false)
    return controller.handle
  }

  controller.setAnimations([
    animateClip(
      focusedSurface,
      clipPathForRect(initialSurfaceRect, focusedSurface.getBoundingClientRect()),
      'inset(0px)',
    ),
    animateFromPreviousRect(
      focusedSurface.querySelector<HTMLElement>('.aa-conversation-scroll-content'),
      initialContentRect,
    ),
    animateFromPreviousRect(
      focusedSurface.querySelector<HTMLElement>('.aa-conversation-composer-frame'),
      initialComposerRect,
    ),
    animateElement(
      focusedSurface.querySelector<HTMLElement>('.aa-focus-header'),
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 160, delay: 100 },
    ),
  ])
  controller.start()
  return controller.handle
}

function exitFocusMode(
  root: HTMLElement,
  surface: HTMLElement,
  main: HTMLElement,
  update: () => void,
): FocusModeTransitionHandle {
  const surfaceRect = surface.getBoundingClientRect()
  const targetSurfaceRect = main.getBoundingClientRect()
  const content = surface.querySelector<HTMLElement>('.aa-conversation-scroll-content')
  const composer = surface.querySelector<HTMLElement>('.aa-conversation-composer-frame')
  const header = surface.querySelector<HTMLElement>('.aa-focus-header')
  const controller = createController(root, 'exit', update)

  controller.setAnimations([
    animateClip(surface, 'inset(0px)', clipPathForRect(targetSurfaceRect, surfaceRect)),
    animateToNormalRect(content, targetSurfaceRect),
    animateToNormalRect(composer, targetSurfaceRect),
    animateElement(
      header,
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: 100 },
    ),
  ])
  controller.start()
  return controller.handle
}

function createController(
  root: HTMLElement,
  direction: FocusTransitionDirection,
  updateOnFinish?: () => void,
): TransitionController {
  const token = `${direction}-${++transitionSequence}`
  let animations: Animation[] = []
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined
  let settled = false

  const finish = (commit: boolean): void => {
    if (settled) return
    settled = true
    if (timeout !== undefined) globalThis.clearTimeout(timeout)
    if (commit) updateOnFinish?.()
    animations.forEach((animation) => animation.cancel())
    if (activeTransitions.get(root)?.token === token) {
      activeTransitions.delete(root)
      delete root.dataset.focusTransition
    }
  }

  const handle: FocusModeTransitionHandle = {
    cancel: () => finish(false),
  }
  activeTransitions.set(root, { token, handle })
  root.dataset.focusTransition = direction

  return {
    handle,
    finish,
    setAnimations: (nextAnimations) => {
      animations = nextAnimations.filter((animation): animation is Animation => animation !== undefined)
    },
    start: () => {
      if (animations.length === 0) {
        finish(true)
        return
      }
      timeout = globalThis.setTimeout(() => finish(true), TRANSITION_DURATION_MS + 40)
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => finish(true))
    },
  }
}

function noOpHandle(): FocusModeTransitionHandle {
  return { cancel: () => undefined }
}

function animateClip(element: HTMLElement, from: string, to: string): Animation {
  return element.animate(
    [{ clipPath: from }, { clipPath: to }],
    animationOptions(),
  )
}

function animateFromPreviousRect(
  element: HTMLElement | null,
  previousRect: DOMRect | undefined,
): Animation | undefined {
  if (element === null || previousRect === undefined) return undefined
  const currentRect = element.getBoundingClientRect()
  return animateTranslation(
    element,
    previousRect.left - currentRect.left,
    0,
    0,
    0,
  )
}

function animateToNormalRect(
  element: HTMLElement | null,
  targetSurfaceRect: DOMRect,
): Animation | undefined {
  if (element === null) return undefined
  const currentRect = element.getBoundingClientRect()
  const targetLeft = targetSurfaceRect.left + (targetSurfaceRect.width - currentRect.width) / 2
  return animateTranslation(
    element,
    0,
    0,
    targetLeft - currentRect.left,
    0,
  )
}

function animateTranslation(
  element: HTMLElement,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): Animation {
  return element.animate(
    [
      { transform: `translate(${fromX}px, ${fromY}px)` },
      { transform: `translate(${toX}px, ${toY}px)` },
    ],
    animationOptions(),
  )
}

function animateElement(
  element: HTMLElement | null,
  keyframes: Keyframe[],
  timing: { readonly duration: number; readonly delay?: number },
): Animation | undefined {
  if (element === null) return undefined
  return element.animate(keyframes, {
    duration: timing.duration,
    delay: timing.delay,
    easing: 'ease-out',
    fill: 'both',
  })
}

function animationOptions(): KeyframeAnimationOptions {
  return {
    duration: TRANSITION_DURATION_MS,
    easing: TRANSITION_EASING,
    fill: 'both',
  }
}

function elementRect(root: HTMLElement, selector: string): DOMRect | undefined {
  return root.querySelector<HTMLElement>(selector)?.getBoundingClientRect()
}

function clipPathForRect(target: DOMRect, surface: DOMRect): string {
  const top = Math.max(0, target.top - surface.top)
  const right = Math.max(0, surface.right - target.right)
  const bottom = Math.max(0, surface.bottom - target.bottom)
  const left = Math.max(0, target.left - surface.left)
  return `inset(${top}px ${right}px ${bottom}px ${left}px)`
}