import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean>(false)

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`)
    
    if (!mql) {
        // Should not happen with standard browser APIs, but guards against unexpected environment issues.
        return;
    }

    const onChange = (event: MediaQueryListEvent) => {
      setIsMobile(event.matches)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(mql.matches)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return isMobile
}