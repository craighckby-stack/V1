import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    // Skip execution on server side
    if (typeof window === "undefined") {
      return
    }

    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    if (!mql) {
      // Fallback for browsers that don't support matchMedia
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
      return
    }

    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    
    return () => {
      mql.removeEventListener("change", onChange)
    }
  }, [])

  return isMobile === undefined ? false : !!isMobile
}