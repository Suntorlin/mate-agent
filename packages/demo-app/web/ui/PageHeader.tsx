import type { ReactNode } from "react";
import { IconButton } from "./IconButton.tsx";
import { ChevronLeft } from "./icons.tsx";
import "./PageHeader.css";

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}

/** The header of a top-level page: a large title (the page's h1) on the left, actions on the right. */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="ui-bar ui-page-header">
      <div className="ui-page-header__text">
        <h1 className="ui-page-header__title">{title}</h1>
        {subtitle && <div className="ui-page-header__subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="ui-page-header__actions">{actions}</div>}
    </header>
  );
}

export interface SubPageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Shown as a back button; leave it out on a desktop column that has nothing to go back to. */
  onBack?: () => void;
  backLabel?: string;
  actions?: ReactNode;
}

/** The header of a second-level page (a chat): back, a title (an h2: a list may sit beside it) and actions. */
export function SubPageHeader({
  title,
  subtitle,
  onBack,
  backLabel = "Back",
  actions,
}: SubPageHeaderProps) {
  return (
    <header className="ui-bar ui-page-header ui-page-header--sub">
      {onBack && (
        <IconButton label={backLabel} onClick={onBack}>
          <ChevronLeft />
        </IconButton>
      )}
      <div className="ui-page-header__text">
        <h2 className="ui-page-header__title ui-page-header__title--sub">{title}</h2>
        {subtitle && <div className="ui-page-header__subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="ui-page-header__actions">{actions}</div>}
    </header>
  );
}
