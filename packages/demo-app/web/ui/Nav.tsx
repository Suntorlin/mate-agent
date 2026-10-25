import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import "./Nav.css";

export interface NavItem<T extends string = string> {
  key: T;
  label: string;
  /** Drawn filled when the item is the current one. */
  icon: (active: boolean) => ReactNode;
}

interface NavProps<T extends string> {
  items: ReadonlyArray<NavItem<T>>;
  active: T;
  onSelect: (key: T) => void;
}

function NavButton<T extends string>({
  item,
  active,
  onSelect,
}: {
  item: NavItem<T>;
  active: boolean;
  onSelect: (key: T) => void;
}) {
  return (
    <button
      type="button"
      className={cx("ui-nav__item", active && "ui-nav__item--active")}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      title={item.label}
      onClick={() => !active && onSelect(item.key)}
    >
      {item.icon(active)}
    </button>
  );
}

/** The phone's bottom bar: icon-only tabs for the top-level pages. */
export function TabBar<T extends string>({ items, active, onSelect }: NavProps<T>) {
  return (
    <nav className="ui-bar ui-tab-bar" aria-label="Main">
      {items.map((item) => (
        <NavButton key={item.key} item={item} active={item.key === active} onSelect={onSelect} />
      ))}
    </nav>
  );
}

export interface NavRailProps<T extends string> extends NavProps<T> {
  /** The mark at the top of the rail. */
  brand: ReactNode;
  /** Items pinned to the bottom of the rail (settings). */
  footerItems?: ReadonlyArray<NavItem<T>>;
}

/** The desktop's slim icon rail on the left edge: the same pages as the tab bar. */
export function NavRail<T extends string>({
  brand,
  items,
  footerItems = [],
  active,
  onSelect,
}: NavRailProps<T>) {
  return (
    <nav className="ui-nav-rail" aria-label="Main">
      <div className="ui-nav-rail__brand">{brand}</div>
      <div className="ui-nav-rail__group">
        {items.map((item) => (
          <NavButton key={item.key} item={item} active={item.key === active} onSelect={onSelect} />
        ))}
      </div>
      <div className="ui-nav-rail__group ui-nav-rail__group--end">
        {footerItems.map((item) => (
          <NavButton key={item.key} item={item} active={item.key === active} onSelect={onSelect} />
        ))}
      </div>
    </nav>
  );
}
