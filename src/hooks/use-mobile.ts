import * as React from "react"

// Drawer-mode breakpoint — phone-class viewports get the off-canvas
// drawer instead of the always-visible rail. Tablets (768-1023px) keep
// the rail but in icon-only mode (see useIsTablet below) so a 256px
// expanded sidebar doesn't squash the content area.
const MOBILE_BREAKPOINT = 768
// Icon-mode breakpoint — at tablet-portrait (768-1023px) the sidebar
// stays mounted but auto-collapses to icon-only width so the content
// area gets a workable ~720px wide.
const TABLET_BREAKPOINT = 1024

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}

/**
 * `true` when the viewport is tablet-portrait — the sidebar should
 * collapse to icon mode at this width so the content area stays
 * usable. Drawer mode (useIsMobile) takes priority below 768px.
 */
export function useIsTablet() {
  const [isTablet, setIsTablet] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(
      `(min-width: ${MOBILE_BREAKPOINT}px) and (max-width: ${TABLET_BREAKPOINT - 1}px)`
    )
    const onChange = () => {
      const w = window.innerWidth
      setIsTablet(w >= MOBILE_BREAKPOINT && w < TABLET_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    onChange()
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isTablet
}
