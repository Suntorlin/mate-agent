import { AbsoluteFill } from "remotion";
import { AudioLayer } from "./AudioLayer";
import { CaptionLayer } from "./CaptionLayer";
import { placeShots } from "./schema.js";
import { ShotLayer } from "./ShotLayer";
import { FONT_STACK } from "./styles";
import { TextLayer } from "./TextLayer";
import type { PlacedShot, Timeline } from "./types";

/** A crossfading shot fades in over the previous one, which stays underneath until it is opaque. */
function visibleUntil(shots: PlacedShot[], index: number): number {
  const shot = shots[index];
  const next = shots[index + 1];
  if (next?.transition?.type !== "crossfade") return shot.end;
  return Math.max(shot.end, next.start + next.transition.duration);
}

export function TimelineVideo(timeline: Timeline) {
  const shots: PlacedShot[] = placeShots(timeline.shots);
  return (
    <AbsoluteFill style={{ backgroundColor: timeline.canvas.background, fontFamily: FONT_STACK }}>
      {shots.map((shot, index) => (
        <ShotLayer key={`shot-${index}`} shot={shot} visibleUntil={visibleUntil(shots, index)} />
      ))}
      {timeline.texts.map((item, index) => (
        <TextLayer key={`text-${index}`} item={item} />
      ))}
      {timeline.captions.map((line, index) => (
        <CaptionLayer key={`caption-${index}`} line={line} />
      ))}
      {timeline.audio.map((track, index) => (
        <AudioLayer key={`audio-${index}`} track={track} />
      ))}
    </AbsoluteFill>
  );
}
