import { createRoot } from "react-dom/client";
import { applyTheme } from "./theme.ts";
import { Showcase } from "./Showcase.tsx";
import "./tokens.css";
import "./base.css";

// `?theme=dark` opens the page dark (for screenshots); otherwise it follows the system.
const requested = new URLSearchParams(location.search).get("theme");
applyTheme(
  requested === "dark" || requested === "light"
    ? requested
    : matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
);

createRoot(document.getElementById("root") as HTMLElement).render(<Showcase />);
