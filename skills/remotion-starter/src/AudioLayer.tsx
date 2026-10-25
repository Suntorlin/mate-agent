import { Html5Audio, Sequence, useVideoConfig } from "remotion";
import { mediaUrl, toFrames } from "./media";
import type { AudioTrack } from "./types";

export function AudioLayer({ track }: { track: AudioTrack }) {
  const { fps } = useVideoConfig();
  return (
    <Sequence
      from={toFrames(track.start, fps)}
      durationInFrames={track.duration ? Math.max(1, toFrames(track.duration, fps)) : undefined}
      layout="none"
      name={`audio ${track.src}`}
    >
      <Html5Audio
        src={mediaUrl(track.src)}
        trimBefore={toFrames(track.trimStart, fps)}
        volume={track.volume}
      />
    </Sequence>
  );
}
