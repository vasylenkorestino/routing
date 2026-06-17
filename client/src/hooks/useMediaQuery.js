import { useState, useEffect } from 'react';

/** Subscribes to a CSS media query and returns whether it currently matches. */
export default function useMediaQuery(query) {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** Convenience: true on phone-sized viewports (< 768px). */
export function useIsMobile() {
  return useMediaQuery('(max-width: 767px)');
}
