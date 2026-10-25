import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx.ts";
import "./IconButton.css";

export type IconButtonVariant = "ghost" | "muted" | "filled";

interface Common {
  /** Required: it is the accessible name and the tooltip of an icon with no text. */
  label: string;
  variant?: IconButtonVariant;
  size?: "default" | "sm";
  className?: string;
  children: ReactNode;
}

export type IconButtonProps = Common &
  (
    | ({ href?: undefined } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "title">)
    | ({ href: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "title">)
  );

/**
 * An icon-only action: a circle, 44px by default (`sm` 36 for dense desktop toolbars). `ghost`
 * is bare, `muted` has a quiet fill, `filled` is the primary action (one per view).
 */
export function IconButton({
  label,
  variant = "ghost",
  size = "default",
  className,
  ...props
}: IconButtonProps) {
  const classes = cx(
    "ui-icon-button",
    `ui-icon-button--${variant}`,
    `ui-icon-button--${size}`,
    className
  );
  if (props.href !== undefined)
    return <a {...props} className={classes} aria-label={label} title={label} />;
  return <button type="button" {...props} className={classes} aria-label={label} title={label} />;
}
