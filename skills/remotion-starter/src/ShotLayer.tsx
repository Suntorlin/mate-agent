import {
  AbsoluteFill,
  Img,
  interpolate,
  OffthreadVideo,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { mediaUrl, toFrames } from "./media";
import { mediaTypeOf } from "./schema.js";
import type { PlacedShot } from "./types";

const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

interface ShotLayerProps {
  shot: PlacedShot;
  /** Seconds; later than shot.end when the next shot crossfades over this one. */
  visibleUntil: number;
}

export function ShotLayer({ shot, visibleUntil }: ShotLayerProps) {
  const { fps } = useVideoConfig();
  const from = toFrames(shot.start, fps);
  const durationInFrames = Math.max(1, toFrames(visibleUntil, fps) - from);
  return (
    <Sequence from={from} durationInFrames={durationInFrames} name={`shot ${shot.src}`}>
      <ShotFrame shot={shot} />
    </Sequence>
  );
}

function kenBurnsTransform(
  shot: PlacedShot,
  frame: number,
  shotFrames: number
): string | undefined {
  if (!shot.kenBurns) return undefined;
  const { from, to } = shot.kenBurns;
  const progress = interpolate(frame, [0, shotFrames], [0, 1], CLAMP);
  const mix = (a: number, b: number) => a + (b - a) * progress;
  return `translate(${mix(from.x, to.x)}%, ${mix(from.y, to.y)}%) scale(${mix(from.scale, to.scale)})`;
}

function ShotFrame({ shot }: { shot: PlacedShot }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fadeFrames =
    shot.transition?.type === "crossfade"
      ? Math.max(1, toFrames(shot.transition.duration, fps))
      : 0;
  const opacity = fadeFrames ? interpolate(frame, [0, fadeFrames], [0, 1], CLAMP) : 1;
  const mediaStyle = { width: "100%", height: "100%", objectFit: shot.fit };
  const src = mediaUrl(shot.src);
  return (
    <AbsoluteFill style={{ opacity, overflow: "hidden" }}>
      <AbsoluteFill
        style={{ transform: kenBurnsTransform(shot, frame, toFrames(shot.duration, fps)) }}
      >
        {mediaTypeOf(shot) === "video" ? (
          <OffthreadVideo
            src={src}
            trimBefore={toFrames(shot.trimStart, fps)}
            volume={shot.volume}
            muted={shot.volume === 0}
            style={mediaStyle}
          />
        ) : (
          <Img src={src} style={mediaStyle} />
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
