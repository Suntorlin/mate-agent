import { interpolate, spring } from "remotion";

interface Entrance {
  opacity: number;
  scale: number;
}

const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Opacity/scale for an overlay that is `frame` frames into a `durationInFrames` window. */
export function entrance(
  animation: "pop" | "fade" | "none",
  frame: number,
  fps: number,
  durationInFrames: number
): Entrance {
  if (animation === "none") return { opacity: 1, scale: 1 };
  const edge = Math.max(1, Math.min(6, Math.floor(durationInFrames / 3)));
  const fadeOut = interpolate(frame, [durationInFrames - edge, durationInFrames], [1, 0], CLAMP);
  if (animation === "fade") {
    return { opacity: Math.min(interpolate(frame, [0, edge], [0, 1], CLAMP), fadeOut), scale: 1 };
  }
  const pop = spring({ frame, fps, config: { damping: 13, stiffness: 210, mass: 0.6 } });
  return {
    opacity: Math.min(interpolate(frame, [0, 2], [0, 1], CLAMP), fadeOut),
    scale: 0.7 + 0.3 * pop,
  };
}
