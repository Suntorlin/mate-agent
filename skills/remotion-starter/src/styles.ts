import type { CSSProperties } from "react";
import type { Position, TextItem } from "./types";

// System fonts baked into the image (fonts-noto-cjk, fonts-noto-color-emoji). The CJK faces carry
// Latin glyphs too, so mixed Chinese/English lines keep one consistent look.
export const FONT_STACK =
  '"Noto Sans CJK SC", "Noto Sans CJK JP", "Noto Sans CJK KR", "Noto Sans", "Noto Color Emoji", sans-serif';

// Vertical anchors (center of the text block, fraction of canvas height). Chosen to stay inside
// the Instagram/TikTok safe area: the top ~10% and bottom ~20% are covered by app chrome.
const ANCHORS: Record<Exclude<Position, { x: number; y: number }>, number> = {
  top: 0.14,
  upper: 0.3,
  center: 0.5,
  lower: 0.68,
  bottom: 0.78,
};

export function anchorStyle(position: Position): CSSProperties {
  const { x, y } = typeof position === "string" ? { x: 0.5, y: ANCHORS[position] } : position;
  return {
    position: "absolute",
    left: `${x * 100}%`,
    top: `${y * 100}%`,
    transform: "translate(-50%, -50%)",
  };
}

export interface TextLook {
  fontSize: number;
  fontWeight: number;
  color: string;
  strokeColor?: string;
  strokeWidth: number;
  background?: string;
  shadow: string;
  animation: "pop" | "fade" | "none";
}

// Sizes are for a 1080px-wide canvas and scale with the actual width.
const LOOKS: Record<TextItem["style"], TextLook> = {
  hook: {
    fontSize: 104,
    fontWeight: 900,
    color: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidth: 14,
    shadow: "0 8px 28px rgba(0,0,0,0.55)",
    animation: "pop",
  },
  title: {
    fontSize: 76,
    fontWeight: 800,
    color: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidth: 8,
    shadow: "0 6px 20px rgba(0,0,0,0.5)",
    animation: "fade",
  },
  caption: {
    fontSize: 62,
    fontWeight: 800,
    color: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidth: 10,
    shadow: "0 4px 12px rgba(0,0,0,0.45)",
    animation: "none",
  },
  label: {
    fontSize: 56,
    fontWeight: 700,
    color: "#111111",
    background: "#FFFFFF",
    strokeWidth: 0,
    shadow: "none",
    animation: "pop",
  },
  plain: {
    fontSize: 54,
    fontWeight: 500,
    color: "#FFFFFF",
    strokeWidth: 0,
    shadow: "0 3px 10px rgba(0,0,0,0.6)",
    animation: "fade",
  },
};

export function textLook(item: TextItem, canvasWidth: number): TextLook {
  const base = LOOKS[item.style];
  const scale = canvasWidth / 1080;
  return {
    ...base,
    fontSize: (item.fontSize ?? base.fontSize) * scale,
    strokeWidth: base.strokeWidth * scale,
    color: item.color ?? base.color,
    strokeColor: item.strokeColor ?? base.strokeColor,
    background: item.background ?? base.background,
    animation: item.animation ?? base.animation,
  };
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef\u3000-\u303f]/;

/** Latin words are separated by spaces; adjacent CJK words are not. */
export function needsGap(current: string, next: string | undefined): boolean {
  if (next === undefined) return false;
  return !(CJK.test(current.slice(-1)) && CJK.test(next.slice(0, 1)));
}
