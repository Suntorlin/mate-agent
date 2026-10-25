import { Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { toFrames } from "./media";
import { StrokedText } from "./StrokedText";
import { anchorStyle, needsGap } from "./styles";
import type { CaptionLine } from "./types";

const DEFAULT_FONT_SIZE = 64;
const DEFAULT_HIGHLIGHT = { highlight: "#FFE14D", box: "#FF3B5C" } as const;

function lineWindow(line: CaptionLine): { start: number; end: number } {
  return {
    start: line.start ?? line.words[0].start,
    end: line.end ?? line.words[line.words.length - 1].end,
  };
}

export function CaptionLayer({ line }: { line: CaptionLine }) {
  const { fps } = useVideoConfig();
  const { start, end } = lineWindow(line);
  const from = toFrames(start, fps);
  return (
    <Sequence from={from} durationInFrames={Math.max(1, toFrames(end, fps) - from)} name="caption">
      <CaptionBlock line={line} />
    </Sequence>
  );
}

function CaptionBlock({ line }: { line: CaptionLine }) {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const { start, end } = lineWindow(line);
  const now = start + frame / fps;
  const scale = width / 1080;
  const color = line.color ?? "#FFFFFF";
  const highlight = line.highlightColor ?? DEFAULT_HIGHLIGHT[line.style];
  return (
    <div
      style={{
        ...anchorStyle(line.position),
        width: "86%",
        textAlign: "center",
        fontSize: (line.fontSize ?? DEFAULT_FONT_SIZE) * scale,
        fontWeight: 800,
        lineHeight: 1.3,
      }}
    >
      {line.words.map((word, index) => {
        const next = line.words[index + 1];
        // A word stays highlighted until the next one starts, so pauses do not flicker.
        const active = now >= word.start && now < (next?.start ?? end);
        return (
          <span
            key={index}
            style={{
              display: "inline-block",
              position: "relative",
              // Neighbours paint over the edge of an active box instead of under it.
              zIndex: active ? 0 : 1,
              marginRight: needsGap(word.text, next?.text) ? "0.3em" : 0,
              transform: active ? "scale(1.06)" : undefined,
            }}
          >
            {line.style === "box" ? (
              <span
                style={{
                  color,
                  background: active ? highlight : "transparent",
                  borderRadius: "0.2em",
                  // The box grows past the word without shifting the layout, so CJK lines keep
                  // their natural (gapless) spacing.
                  padding: "0 0.12em",
                  margin: "0 -0.12em",
                  textShadow: active ? "none" : "0 3px 10px rgba(0,0,0,0.7)",
                }}
              >
                {word.text}
              </span>
            ) : (
              <StrokedText
                text={word.text}
                color={active ? highlight : color}
                strokeColor="#000000"
                strokeWidth={10 * scale}
                shadow="0 4px 12px rgba(0,0,0,0.45)"
              />
            )}
          </span>
        );
      })}
    </div>
  );
}
