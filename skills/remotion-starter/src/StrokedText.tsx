import type { CSSProperties } from "react";

interface StrokedTextProps {
  text: string;
  color: string;
  strokeColor?: string;
  strokeWidth: number;
  shadow: string;
  style?: CSSProperties;
}

/**
 * Outlined text that stays legible over any footage. The outline is a second copy of the text
 * stacked underneath the fill, so the stroke never eats into thin glyphs (CJK strokes included).
 */
export function StrokedText({
  text,
  color,
  strokeColor,
  strokeWidth,
  shadow,
  style,
}: StrokedTextProps) {
  if (!strokeColor || strokeWidth <= 0) {
    return <span style={{ ...style, color, textShadow: shadow }}>{text}</span>;
  }
  return (
    <span style={{ ...style, display: "inline-grid" }}>
      <span
        aria-hidden
        style={{
          gridArea: "1 / 1",
          color: strokeColor,
          WebkitTextStroke: `${strokeWidth}px ${strokeColor}`,
          textShadow: shadow,
        }}
      >
        {text}
      </span>
      <span style={{ gridArea: "1 / 1", color }}>{text}</span>
    </span>
  );
}
