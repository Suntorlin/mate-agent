import type { ThemeControl } from "./design/theme.ts";
import { IconButton } from "./ui/index.ts";
import { Moon, Sun } from "./ui/icons.tsx";

/** Switches between light and dark; the icon shows what a tap switches to. */
export function ThemeToggle({ theme, toggle }: ThemeControl) {
  return (
    <IconButton
      size="sm"
      label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      onClick={toggle}
    >
      {theme === "dark" ? <Sun /> : <Moon />}
    </IconButton>
  );
}
