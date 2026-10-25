import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import "./Badge.css";

export type BadgeVariant = "default" | "solid" | "info" | "success" | "warning" | "destructive";

export interface BadgeProps {
  variant?: BadgeVariant;
  /** A leading icon, 16px. */
  icon?: ReactNode;
  children: ReactNode;
  title?: string;
}

/** A state pill (no border), 24px tall. It says what something is; it is never an action. */
export function Badge({ variant = "default", icon, children, title }: BadgeProps) {
  return (
    <span className={cx("ui-badge", `ui-badge--${variant}`)} title={title}>
      {icon}
      {children}
    </span>
  );
}
