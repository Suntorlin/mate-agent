import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import { Chevron } from "./icons.tsx";
import "./ListRow.css";

/** An iOS-style grouped list: a 16px-radius container with hairlines between its rows. */
export function ListGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("ui-list-group", className)}>{children}</div>;
}

export interface ListRowProps {
  /** A small icon on a muted tile. */
  icon?: ReactNode;
  /** Custom leading content with no tile around it (an Avatar). */
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  /** Makes the row a button, with a chevron unless `trailing` is given or `chevron` is off. */
  onClick?: () => void;
  /** Whether a pressable row ends in a chevron (a list of chats does not). Default: yes. */
  chevron?: boolean;
  selected?: boolean;
  /** A destructive action (sign out): the title is red. */
  destructive?: boolean;
  /** Dense rows (36px; 44px on a phone) for a sidebar; the default is the 52px settings row. */
  compact?: boolean;
}

export function ListRow({
  icon,
  leading,
  title,
  subtitle,
  trailing,
  onClick,
  chevron = true,
  selected,
  destructive,
  compact,
}: ListRowProps) {
  const classes = cx(
    "ui-list-row",
    compact && "ui-list-row--compact",
    selected && "ui-list-row--selected",
    destructive && "ui-list-row--destructive",
    onClick && "ui-list-row--pressable"
  );
  const body = (
    <>
      {leading}
      {icon && <span className="ui-list-row__icon">{icon}</span>}
      <span className="ui-list-row__text">
        <span className="ui-list-row__title">{title}</span>
        {subtitle && <span className="ui-list-row__subtitle">{subtitle}</span>}
      </span>
      {trailing ?? (onClick && chevron && !compact ? <Chevron /> : null)}
    </>
  );
  if (!onClick) return <div className={classes}>{body}</div>;
  return (
    <button
      type="button"
      className={classes}
      onClick={onClick}
      aria-current={selected || undefined}
    >
      {body}
    </button>
  );
}
