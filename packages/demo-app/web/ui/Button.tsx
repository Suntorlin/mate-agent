import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx.ts";
import "./Button.css";

export type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive";
export type ButtonSize = "sm" | "default" | "lg";

interface Common {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children?: ReactNode;
}

export type ButtonProps = Common &
  (
    | ({ href?: undefined } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">)
    | ({ href: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className">)
  );

/**
 * The one button: a pill, 44px tall by default (`sm` 36 for dense toolbars, `lg` 48). One filled
 * (`default`) button per view; everything else is secondary, outline or ghost. With `href` it is a
 * link that looks the same.
 */
export function Button({
  variant = "default",
  size = "default",
  className,
  ...props
}: ButtonProps) {
  const classes = cx("ui-button", `ui-button--${variant}`, `ui-button--size-${size}`, className);
  if (props.href !== undefined) return <a {...props} className={classes} />;
  return <button type="button" {...props} className={classes} />;
}
