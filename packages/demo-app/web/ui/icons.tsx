/** The line icons the app uses, drawn at 20px on a 24px grid in the current text colour: the design system's icon set. */

import type { ReactNode } from "react";

function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const ArrowUp = () => (
  <Icon>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </Icon>
);
export const StopSquare = () => (
  <Icon>
    <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
  </Icon>
);
export const Plus = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const Coins = () => (
  <Icon size={16}>
    <ellipse cx="9" cy="7" rx="6" ry="3" />
    <path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7" />
    <path d="M15 10.2c3.1.3 6 1.4 6 2.8v4c0 1.7-2.7 3-6 3-2.5 0-4.6-.7-5.5-1.8" />
  </Icon>
);
export const Download = () => (
  <Icon>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Icon>
);
export const Close = () => (
  <Icon>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);
export const PanelRight = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M14 4v16" />
  </Icon>
);
export const Globe = () => (
  <Icon size={16}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
  </Icon>
);
export const FileIcon = ({ size = 16 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </Icon>
);
export const ImageIcon = () => (
  <Icon size={16}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <circle cx="9" cy="10" r="2" />
    <path d="M21 16l-5-5-9 9" />
  </Icon>
);
export const Step = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
  </Icon>
);
export const Check = () => (
  <Icon>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);
export const Sun = () => (
  <Icon>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
  </Icon>
);
export const Moon = () => (
  <Icon>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
  </Icon>
);
export const Menu = () => (
  <Icon>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);
export const Chevron = () => (
  <Icon size={16}>
    <path d="M9 6l6 6-6 6" />
  </Icon>
);
export const ChevronLeft = () => (
  <Icon>
    <path d="M15 5l-7 7 7 7" />
  </Icon>
);
export const ChatsIcon = ({ filled }: { filled?: boolean }) => (
  <Icon size={25}>
    <path
      d="M12 3.5c-4.97 0-9 3.47-9 7.75 0 2.33 1.2 4.42 3.09 5.84-.13 1.17-.62 2.33-1.44 3.25 1.9-.12 3.56-.8 4.73-1.73.84.25 1.72.39 2.62.39 4.97 0 9-3.47 9-7.75S16.97 3.5 12 3.5z"
      fill={filled ? "currentColor" : "none"}
    />
  </Icon>
);
export const MeIcon = ({ filled }: { filled?: boolean }) => (
  <Icon size={25}>
    <circle cx="12" cy="8" r="4" fill={filled ? "currentColor" : "none"} />
    <path d="M4 20.5c.8-4 4-6.5 8-6.5s7.2 2.5 8 6.5z" fill={filled ? "currentColor" : "none"} />
  </Icon>
);
