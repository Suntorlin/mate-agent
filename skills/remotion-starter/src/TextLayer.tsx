import { Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { entrance } from "./animation";
import { toFrames } from "./media";
import { StrokedText } from "./StrokedText";
import { anchorStyle, textLook } from "./styles";
import type { TextItem } from "./types";

export function TextLayer({ item }: { item: TextItem }) {
  const { fps } = useVideoConfig();
  const durationInFrames = Math.max(1, toFrames(item.duration, fps));
  return (
    <Sequence
      from={toFrames(item.start, fps)}
      durationInFrames={durationInFrames}
      name={`text ${item.text}`}
    >
      <TextBlock item={item} durationInFrames={durationInFrames} />
    </Sequence>
  );
}

function TextBlock({ item, durationInFrames }: { item: TextItem; durationInFrames: number }) {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const look = textLook(item, width);
  const { opacity, scale } = entrance(look.animation, frame, fps, durationInFrames);
  return (
    <div
      style={{
        ...anchorStyle(item.position),
        width: `${item.maxWidth * 100}%`,
        textAlign: item.align,
        opacity,
      }}
    >
      <div
        style={{
          transform: `scale(${scale})`,
          fontSize: look.fontSize,
          fontWeight: look.fontWeight,
          lineHeight: 1.18,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {look.background ? (
          <span
            style={{
              color: look.color,
              background: look.background,
              padding: "0.1em 0.4em",
              borderRadius: "0.25em",
              lineHeight: 1.55,
              boxDecorationBreak: "clone",
              WebkitBoxDecorationBreak: "clone",
            }}
          >
            {item.text}
          </span>
        ) : (
          <StrokedText
            text={item.text}
            color={look.color}
            strokeColor={look.strokeColor}
            strokeWidth={look.strokeWidth}
            shadow={look.shadow}
          />
        )}
      </div>
    </div>
  );
}
