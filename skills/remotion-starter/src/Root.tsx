import { CalculateMetadataFunction, Composition } from "remotion";
import { parseTimeline, totalSeconds } from "./schema.js";
import { TimelineVideo } from "./TimelineVideo";
import type { Timeline } from "./types";

// Props are the timeline itself. render.sh validates and stages media before calling Remotion;
// this re-validation keeps direct `remotion render --props` calls from rendering garbage.
const calculateMetadata: CalculateMetadataFunction<Timeline> = ({ props }) => {
  const parsed = parseTimeline(props);
  if (parsed.errors) {
    throw new Error(`Invalid timeline (render with render.sh):\n${parsed.errors.join("\n")}`);
  }
  const timeline = parsed.timeline;
  const { width, height, fps } = timeline.canvas;
  return {
    durationInFrames: Math.max(1, Math.round(totalSeconds(timeline) * fps)),
    width,
    height,
    fps,
    props: timeline,
  };
};

export function Root() {
  return (
    <Composition
      id="Timeline"
      component={TimelineVideo}
      calculateMetadata={calculateMetadata}
      defaultProps={{} as Timeline}
      durationInFrames={1}
      fps={30}
      width={1080}
      height={1920}
    />
  );
}
