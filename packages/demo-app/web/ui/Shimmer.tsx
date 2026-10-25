import type { ReactNode } from "react";
import "./Shimmer.css";

/** Text that glints while something is in progress ("Thinking…", the running step). */
export function Shimmer({ children }: { children: ReactNode }) {
  return <span className="ui-shimmer">{children}</span>;
}
