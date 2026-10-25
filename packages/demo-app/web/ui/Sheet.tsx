import { useEffect, useRef, type ReactNode } from "react";
import { cx } from "./cx.ts";
import "./Sheet.css";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** Where it comes from: the bottom for a preview, the left for navigation. */
  side?: "bottom" | "left";
  label: string;
  children: ReactNode;
}

/** A panel over the page with a scrim behind it; Escape and a tap on the scrim close it. */
export function Sheet({ open, onClose, side = "bottom", label, children }: SheetProps) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="ui-sheet">
      <div className="ui-sheet__scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={panel}
        className={cx("ui-sheet__panel", `ui-sheet__panel--${side}`)}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
