import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import "./Tabs.css";

export interface TabItem {
  id: string;
  label: string;
  icon?: ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  label: string;
}

/** A row of pill tabs that scrolls sideways when there are many; one is selected. */
export function Tabs({ items, selectedId, onSelect, label }: TabsProps) {
  return (
    <div className="ui-tabs" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === selectedId}
          className={cx("ui-tab", item.id === selectedId && "ui-tab--selected")}
          onClick={() => onSelect(item.id)}
          title={item.label}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}
