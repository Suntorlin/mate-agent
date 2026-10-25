import type { CSSProperties } from "react";
import { cx } from "./cx.ts";
import "./Avatar.css";

const ORB_FAMILIES = 6;

/** A small deterministic hash, so a seed always gives the same orb. */
function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

export interface AvatarProps {
  /** Anything stable (an id): the same seed always draws the same orb. */
  seed: string;
  size?: "sm" | "default" | "lg";
}

/** A round, matte gradient orb in place of a picture. Decorative: it has no text. */
export function Avatar({ seed, size = "default" }: AvatarProps) {
  const value = hash(seed);
  const family = value % ORB_FAMILIES;
  const style = {
    "--avatar-a": `var(--orb-${family}-0)`,
    "--avatar-b": `var(--orb-${family}-1)`,
    "--avatar-c": `var(--orb-${family}-2)`,
    "--avatar-x": `${20 + ((value >>> 4) % 40)}%`,
    "--avatar-y": `${20 + ((value >>> 9) % 40)}%`,
  } as CSSProperties;
  return (
    <span className={cx("ui-avatar", `ui-avatar--${size}`)} style={style} aria-hidden="true" />
  );
}
