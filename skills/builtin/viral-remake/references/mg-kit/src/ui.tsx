import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export const KR = '"Noto Sans CJK KR", "Noto Sans CJK SC", "Noto Color Emoji", sans-serif';
export const DISPLAY = KR; // use with fontWeight 900 (fonts are installed locally; no network at render time)
export const EN = '"Noto Sans", "Noto Sans CJK KR", sans-serif';

export const C = {
  coral: "#FF5A36",
  gold: "#FFC93C",
  cream: "#FFF4E2",
  ink: "#15161A",
  navy: "#0B1026",
  red: "#C8161E",
};

export const sec = (s: number) => Math.round(s * 24);

/** 0→1 spring that starts at `at` frames (relative to the enclosing Sequence). */
export const useIn = (at = 0, damping = 14) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: f - at, fps, config: { damping, mass: 0.7 } });
};

export const fadeOut = (f: number, start: number, len = 8) =>
  interpolate(f, [start, start + len], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

/** Characters typed so far, one every `cps`-derived frames. */
export const typed = (text: string, f: number, start: number, cps = 16) => {
  const chars = Array.from(text);
  const n = Math.max(0, Math.min(chars.length, Math.floor(((f - start) / 24) * cps)));
  return chars.slice(0, n).join("");
};

export const Shimmer: React.FC<{ text: string; size?: number; color?: string }> = ({
  text,
  size = 40,
  color = C.coral,
}) => {
  // Opacity pulse instead of background-clip:text, which the sandbox's headless Chrome paints as a
  // solid bar (seen in two sandbox renders on 2026-09-30).
  const f = useCurrentFrame();
  const pulse = 0.55 + 0.45 * Math.abs(Math.sin(f / 9));
  return (
    <span style={{ fontFamily: KR, fontWeight: 700, fontSize: size, color, opacity: pulse }}>
      {text}
    </span>
  );
};

export const WaveGlyph: React.FC<{ size?: number; color?: string }> = ({
  size = 34,
  color = C.coral,
}) => {
  const f = useCurrentFrame();
  return (
    <div style={{ display: "flex", gap: size * 0.1, alignItems: "center", height: size }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          style={{
            width: size * 0.12,
            borderRadius: size,
            background: color,
            height: size * (0.35 + 0.65 * Math.abs(Math.sin(f / 5 + i * 0.9))),
          }}
        />
      ))}
    </div>
  );
};

/** Messenger-style notification stack, top right. */
export const Bubbles: React.FC<{
  sender: string;
  lines: { at: number; text: string }[];
  hideAt?: number;
}> = ({ sender, lines, hideAt }) => {
  const f = useCurrentFrame();
  const out = hideAt === undefined ? 1 : fadeOut(f, hideAt);
  return (
    <AbsoluteFill style={{ alignItems: "flex-end", padding: 40, opacity: out }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          alignItems: "flex-start",
          width: 470,
        }}
      >
        <div
          style={{
            fontFamily: KR,
            fontWeight: 700,
            fontSize: 20,
            color: "#fff",
            textShadow: "0 2px 8px #0008",
          }}
        >
          <span
            style={{
              display: "inline-flex",
              width: 34,
              height: 34,
              borderRadius: 12,
              background: C.gold,
              color: C.ink,
              alignItems: "center",
              justifyContent: "center",
              marginRight: 10,
            }}
          >
            {sender[0]}
          </span>
          {sender} <span style={{ fontWeight: 500, opacity: 0.8, marginLeft: 8 }}>지금</span>
        </div>
        {lines.map((l, i) => {
          const p = spring({ frame: f - l.at, fps: 24, config: { damping: 13, mass: 0.6 } });
          return (
            <div
              key={i}
              style={{
                transform: `translateY(${(1 - p) * 30}px) scale(${0.9 + 0.1 * p})`,
                transformOrigin: "left top",
                opacity: p,
                background: "#FEE500",
                color: C.ink,
                fontFamily: KR,
                fontWeight: 700,
                fontSize: 27,
                padding: "14px 20px",
                borderRadius: 20,
                borderTopLeftRadius: 6,
                boxShadow: "0 10px 30px #0006",
              }}
            >
              {l.text}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/** Agent prompt bar at the bottom of a live shot. */
export const PromptBar: React.FC<{
  text: string;
  start: number;
  hideAt: number;
  sentAt?: number;
}> = ({ text, start, hideAt, sentAt }) => {
  const f = useCurrentFrame();
  const p = useIn(start - 6);
  const shown = typed(text, f, start, 15);
  const sent = sentAt !== undefined && f >= sentAt;
  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: 46,
        opacity: p * fadeOut(f, hideAt),
      }}
    >
      <div
        style={{
          width: 900,
          transform: `translateY(${(1 - p) * 40}px)`,
          background: "rgba(18,19,24,0.82)",
          backdropFilter: "blur(14px)",
          border: "1px solid rgba(255,255,255,0.14)",
          borderRadius: 24,
          padding: "18px 22px",
          display: "flex",
          alignItems: "center",
          gap: 16,
          boxShadow: "0 18px 50px #0008",
        }}
      >
        <WaveGlyph size={26} />
        <div
          style={{
            flex: 1,
            fontFamily: KR,
            fontWeight: 500,
            fontSize: 26,
            color: "#fff",
            minHeight: 36,
          }}
        >
          {shown}
          {!sent && (
            <span style={{ opacity: Math.floor(f / 6) % 2 ? 1 : 0, color: C.coral }}>|</span>
          )}
        </div>
        <div style={{ fontFamily: EN, fontSize: 16, color: "#ffffffaa", whiteSpace: "nowrap" }}>
          Claude · Acme MCP
        </div>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 14,
            background: sent ? C.coral : "#ffffff22",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontSize: 24,
            transform: `scale(${sent ? 1.12 : 1})`,
          }}
        >
          ↑
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const Vignette: React.FC = () => (
  <AbsoluteFill
    style={{
      background: "radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.45) 100%)",
    }}
  />
);

export const Mascot: React.FC<{ size: number; bob?: boolean }> = ({ size, bob = true }) => {
  const f = useCurrentFrame();
  const y = bob ? Math.sin(f / 5) * size * 0.04 : 0;
  const sq = bob ? 1 + Math.sin(f / 5 + 1.5) * 0.03 : 1;
  return (
    <Img
      src={staticFile("assets/mascot.png")}
      style={{
        width: size,
        transform: `translateY(${y}px) scale(${sq}, ${2 - sq})`,
        filter: "drop-shadow(0 12px 18px #0007)",
      }}
    />
  );
};
