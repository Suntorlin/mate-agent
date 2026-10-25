import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import "./Notice.css";

export interface NoticeProps {
  tone?: "danger" | "neutral";
  children: ReactNode;
}

/** A short message in a pill. `danger` is announced to screen readers as an alert. */
export function Notice({ tone = "neutral", children }: NoticeProps) {
  return (
    <div
      className={cx("ui-notice", `ui-notice--${tone}`)}
      role={tone === "danger" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
