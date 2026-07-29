import { useCallback, useSyncExternalStore } from 'react'

/**
 * Live match for a CSS media query, for the handful of places a layout choice
 * cannot be expressed in a class name — the dock has to be a *different kind of
 * element* on a phone (an overlay drawer) than on a desktop (a column that
 * takes width), and that is a React decision, not a Tailwind one.
 *
 * Server/test render (no `matchMedia`) reports a match, so the desktop layout
 * is the one that renders when the viewport is unknowable.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof matchMedia !== 'function') return () => {}
      const mq = matchMedia(query)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    useCallback(() => (typeof matchMedia === 'function' ? matchMedia(query).matches : true), [query]),
    () => true,
  )
}

/** Tailwind's `md` breakpoint — the app's desktop / narrow divide. */
export const MD_QUERY = '(min-width: 768px)'

export function useIsDesktop(): boolean {
  return useMediaQuery(MD_QUERY)
}
