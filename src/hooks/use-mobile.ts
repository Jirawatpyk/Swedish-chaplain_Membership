import * as React from "react"

// 1024 (Tailwind lg) — at <=1024px the sidebar collapses into a mobile
// drawer so the content area never gets squashed below ~720px on
// tablet-portrait viewports. F4 layout-responsive E2E test expects
// no horizontal scroll at 768px which requires this breakpoint.
const MOBILE_BREAKPOINT = 1024

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
