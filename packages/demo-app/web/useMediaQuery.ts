import { useEffect, useState } from "react";

/** Whether a CSS media query matches now, and again whenever it changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Phones: the sidebar becomes a sheet and the preview a bottom sheet. */
export const PHONE_QUERY = "(max-width: 767px)";
