import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx.ts";
import "./Chip.css";

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  /** Filled: the chosen one of a set. */
  selected?: boolean;
  className?: string;
  children: ReactNode;
}

/** A 32px pill for filters, choices and shortcuts; a tap is a 44px hit area. */
export function Chip({ selected, className, ...props }: ChipProps) {
  return (
    <button
      type="button"
      {...props}
      aria-pressed={selected}
      className={cx("ui-chip", selected && "ui-chip--selected", className)}
    />
  );
}

/** The same pill as plain text, when it only states something (the model in use). */
export function StaticChip({ children }: { children: ReactNode }) {
  return <span className="ui-chip ui-chip--static">{children}</span>;
}
