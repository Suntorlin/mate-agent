import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  interpolate,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { useAudioData, visualizeAudio } from "@remotion/media-utils";
import { C, DISPLAY, EN, KR, Mascot, Shimmer, WaveGlyph, fadeOut, sec, typed, useIn } from "./ui";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** 0–4s: title over the alley. */
export const Title: React.FC = () => {
  const f = useCurrentFrame();
  const a = useIn(4);
  const b = useIn(sec(1.3));
  const out = fadeOut(f, sec(3.5));
  const blur = interpolate(b, [0, 1], [18, 0]);
  return (
    <AbsoluteFill style={{ opacity: out }}>
      <div
        style={{
          position: "absolute",
          top: 40,
          left: 48,
          display: "flex",
          alignItems: "center",
          gap: 12,
          opacity: a * fadeOut(f, sec(1.2)),
        }}
      >
        <WaveGlyph size={30} color="#fff" />
        <span style={{ fontFamily: EN, fontWeight: 700, fontSize: 30, color: "#fff" }}>
          Acme Studio
        </span>
        <span
          style={{
            fontFamily: EN,
            fontWeight: 500,
            fontSize: 14,
            color: "#fff",
            border: "1px solid #fff8",
            borderRadius: 8,
            padding: "2px 7px",
          }}
        >
          MCP
        </span>
      </div>
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: 10,
          filter: `blur(${blur}px)`,
          opacity: b,
        }}
      >
        <div
          style={{ fontFamily: EN, fontWeight: 500, fontSize: 30, color: "#fff", letterSpacing: 2 }}
        >
          Acme Studio MCP <span style={{ color: C.gold }}>×</span> Claude
        </div>
        <div
          style={{
            fontFamily: EN,
            fontWeight: 700,
            fontSize: 132,
            color: "#fff",
            letterSpacing: -4,
            lineHeight: 1,
            textShadow: "0 8px 40px #0009",
          }}
        >
          VOICE &amp; MOTION
        </div>
        <div
          style={{
            fontFamily: KR,
            fontWeight: 700,
            fontSize: 28,
            color: "#fff",
            background: C.coral,
            borderRadius: 14,
            padding: "6px 18px",
            marginTop: 8,
          }}
        >
          목소리부터 영상까지, 프롬프트 한 줄로
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Bottom-left K-drama location caption. */
export const Location: React.FC<{ text: string }> = ({ text }) => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{ justifyContent: "flex-end", padding: 48, opacity: fadeOut(f, sec(3.3)) }}
    >
      <div
        style={{
          fontFamily: KR,
          fontWeight: 500,
          fontSize: 26,
          color: "#fff",
          letterSpacing: 1,
          textShadow: "0 2px 10px #000c",
        }}
      >
        {typed(text, f, 8, 14)}
      </div>
    </AbsoluteFill>
  );
};

/** 15–20s: status card, then the 달빛 떡볶이 logo build. */
export const LogoBuild: React.FC = () => {
  const f = useCurrentFrame();
  const cardOut = interpolate(f, [sec(1.6), sec(1.9)], [1, 0], clamp);
  const logoIn = interpolate(f, [sec(1.6), sec(2.0)], [0, 1], clamp);
  const moon = spring({ frame: f - sec(1.9), fps: 24, config: { damping: 12 } });
  const masc = spring({ frame: f - sec(2.4), fps: 24, config: { damping: 8, mass: 0.6 } });
  const title = spring({ frame: f - sec(2.2), fps: 24, config: { damping: 14 } });
  const chips = ["mascot.bounce(1.2)", "moon.glow = 'gold'", "ease: spring(12)", "voice: ko-KR"];
  return (
    <AbsoluteFill style={{ background: "#FAFAF7" }}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: cardOut }}>
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          <WaveGlyph size={40} />
          <div>
            <div style={{ fontFamily: KR, fontWeight: 700, fontSize: 44, color: C.ink }}>
              브리프 접수 완료.
            </div>
            <Shimmer text="로고부터 시작할게요…" size={40} />
          </div>
        </div>
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          opacity: logoIn,
          background: `radial-gradient(circle at 50% 38%, #E3242B 0%, ${C.red} 38%, #5A0A0E 100%)`,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 70 + (1 - moon) * 120,
            width: 150,
            height: 150,
            borderRadius: "50%",
            boxShadow: `-38px 0 0 0 ${C.gold}`,
            transform: "translateX(40px)",
            filter: `drop-shadow(0 0 ${30 * moon}px ${C.gold})`,
            opacity: moon,
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 30, marginTop: 90 }}>
          <div style={{ transform: `scale(${masc}) rotate(${(1 - masc) * -25}deg)` }}>
            <Mascot size={230} />
          </div>
          <div style={{ transform: `translateY(${(1 - title) * 40}px)`, opacity: title }}>
            <div
              style={{
                fontFamily: DISPLAY,
                fontWeight: 900,
                fontSize: 150,
                color: C.cream,
                lineHeight: 1,
                WebkitTextStroke: `3px #5A0A0E`,
                textShadow: "0 10px 0 #5A0A0E",
              }}
            >
              달빛 떡볶이
            </div>
            <div
              style={{
                fontFamily: EN,
                fontWeight: 700,
                fontSize: 30,
                color: C.gold,
                letterSpacing: 10,
                marginTop: 10,
              }}
            >
              MOONLIGHT TTEOKBOKKI
            </div>
          </div>
        </div>
        {chips.map((c, i) => {
          const p = spring({ frame: f - sec(2.8) - i * 4, fps: 24, config: { damping: 13 } });
          const pos = [
            [70, 110],
            [930, 90],
            [90, 600],
            [960, 610],
          ][i];
          return (
            <div
              key={c}
              style={{
                position: "absolute",
                left: pos[0],
                top: pos[1],
                opacity: p,
                transform: `translateY(${(1 - p) * 20}px)`,
                fontFamily: "Menlo, monospace",
                fontSize: 22,
                color: C.gold,
                background: "#00000055",
                border: `1px solid ${C.gold}66`,
                padding: "6px 12px",
                borderRadius: 10,
              }}
            >
              {c}
            </div>
          );
        })}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** 20–24s: the mascot pops onto the stall table. */
export const MascotPop: React.FC = () => {
  const f = useCurrentFrame();
  const p = spring({ frame: f - sec(0.7), fps: 24, config: { damping: 7, mass: 0.6 } });
  const label = useIn(sec(1.3));
  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: 890,
          top: 330,
          transform: `scale(${p})`,
          transformOrigin: "50% 100%",
        }}
      >
        <Mascot size={250} />
        <div
          style={{
            position: "absolute",
            top: -30,
            left: 40,
            opacity: label,
            fontFamily: "Menlo, monospace",
            fontSize: 18,
            color: "#fff",
            background: "#000a",
            borderRadius: 8,
            padding: "4px 10px",
          }}
        >
          mascot_v2.png ✦
        </div>
      </div>
    </AbsoluteFill>
  );
};

const VOICES = [
  { name: "차분한 남성", tag: "Calm · Male", file: "audio/cast_a.mp3", at: 1.1 },
  { name: "밝은 20대", tag: "Bright · Young", file: "audio/cast_b.mp3", at: 2.3 },
  { name: "따뜻한 내레이터", tag: "Warm · Narrator", file: "audio/cast_c.mp3", at: 3.5 },
];

const Waveform: React.FC<{ src: string; startFrame: number }> = ({ src, startFrame }) => {
  const f = useCurrentFrame();
  const data = useAudioData(staticFile(src));
  const bars = 48;
  const vals =
    data && f >= startFrame
      ? visualizeAudio({ fps: 24, frame: f - startFrame, audioData: data, numberOfSamples: 64 })
      : [];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, height: 180 }}>
      {Array.from({ length: bars }).map((_, i) => {
        const v = vals.length ? vals[i % vals.length] : 0;
        const idle = 0.12 + 0.1 * Math.abs(Math.sin(f / 5 + i / 2.5));
        const h = Math.min(1, idle + Math.sqrt(v) * 2.2);
        return (
          <div
            key={i}
            style={{
              width: 10,
              height: 180 * h,
              borderRadius: 6,
              background: `linear-gradient(${C.gold}, ${C.coral})`,
            }}
          />
        );
      })}
    </div>
  );
};

/** 24–29s: Korean voice casting. */
export const VoiceCasting: React.FC = () => {
  const f = useCurrentFrame();
  const active = VOICES.reduce((acc, v, i) => (f >= sec(v.at) ? i : acc), -1);
  const chosen = f >= sec(4.4);
  const cur = VOICES[Math.max(0, active)];
  return (
    <AbsoluteFill
      style={{
        background: "radial-gradient(circle at 50% 40%, #1C1D24 0%, #0E0F13 70%)",
        padding: 70,
        gap: 34,
        justifyContent: "center",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16, justifyContent: "center" }}>
        <WaveGlyph size={34} />
        {chosen ? (
          <span style={{ fontFamily: KR, fontWeight: 700, fontSize: 40, color: "#fff" }}>
            내레이션 확정 · 따뜻한 내레이터
          </span>
        ) : (
          <Shimmer text="한국어 내레이션 캐스팅 중…" size={40} color="#FFB199" />
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "center" }}>
        <Waveform src={cur.file} startFrame={sec(cur.at)} />
      </div>
      <div
        style={{
          fontFamily: KR,
          fontWeight: 900,
          fontSize: 56,
          color: "#fff",
          textAlign: "center",
        }}
      >
        “달빛 떡볶이.”
      </div>
      <div style={{ display: "flex", gap: 22, justifyContent: "center" }}>
        {VOICES.map((v, i) => {
          const on = i === active;
          const pick = chosen && i === 2;
          return (
            <div
              key={v.name}
              style={{
                width: 300,
                padding: "18px 22px",
                borderRadius: 20,
                background: pick ? C.coral : on ? "#FFFFFF1F" : "#FFFFFF0D",
                border: `2px solid ${on || pick ? C.coral : "#FFFFFF22"}`,
                transform: `scale(${on ? 1.05 : 1})`,
              }}
            >
              <div style={{ fontFamily: KR, fontWeight: 700, fontSize: 28, color: "#fff" }}>
                {v.name} {pick ? "✓" : ""}
              </div>
              <div style={{ fontFamily: EN, fontSize: 18, color: "#ffffffaa", marginTop: 4 }}>
                {v.tag}
              </div>
            </div>
          );
        })}
      </div>
      {VOICES.map((v) => (
        <Sequence key={v.file} from={sec(v.at)}>
          <Audio src={staticFile(v.file)} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

/** 33–37s: neon market map with photo cards. */
export const MarketMap: React.FC = () => {
  const f = useCurrentFrame();
  const route = interpolate(f, [sec(0.4), sec(2.6)], [1, 0], clamp);
  const pins = [
    { x: 300, y: 470, label: "달빛 떡볶이 본점", at: 0.5 },
    { x: 640, y: 330, label: "을지로 포차", at: 1.4 },
    { x: 960, y: 250, label: "광장시장", at: 2.3 },
  ];
  const cards = [
    { img: "assets/stall_a.jpg", label: "을지로 포차 · 도보 2분", x: 770, y: 380, at: 1.7 },
    { img: "assets/stall_b.jpg", label: "광장시장 · 도보 6분", x: 980, y: 300, at: 2.6 },
  ];
  return (
    <AbsoluteFill style={{ background: C.navy }}>
      <svg width={1280} height={720} style={{ position: "absolute" }}>
        {Array.from({ length: 14 }).map((_, i) => (
          <line
            key={`v${i}`}
            x1={i * 100 - 20}
            y1={0}
            x2={i * 100 + 80}
            y2={720}
            stroke="#1E2A5A"
            strokeWidth={2}
          />
        ))}
        {Array.from({ length: 9 }).map((_, i) => (
          <line
            key={`h${i}`}
            x1={0}
            y1={i * 90}
            x2={1280}
            y2={i * 90 - 40}
            stroke="#1E2A5A"
            strokeWidth={2}
          />
        ))}
        <path
          d="M -20 640 C 300 560, 600 700, 1300 560"
          stroke="#1D4ED8"
          strokeWidth={34}
          fill="none"
          opacity={0.5}
        />
        <path
          d="M 300 470 C 420 420, 520 360, 640 330 S 860 280, 960 250"
          stroke={C.coral}
          strokeWidth={8}
          fill="none"
          strokeDasharray="1200"
          strokeDashoffset={1200 * route}
          style={{ filter: `drop-shadow(0 0 10px ${C.coral})` }}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          top: 46,
          left: 56,
          fontFamily: DISPLAY,
          fontWeight: 900,
          fontSize: 64,
          color: C.cream,
        }}
      >
        달빛 시장 맛지도
      </div>
      <div
        style={{
          position: "absolute",
          top: 60,
          right: 56,
          background: "#fff",
          borderRadius: 16,
          padding: "12px 18px",
          display: "flex",
          gap: 12,
          alignItems: "center",
        }}
      >
        <WaveGlyph size={22} />
        <Shimmer text="가게 사진 생성 중…" size={22} />
      </div>
      {pins.map((p) => {
        const s = spring({ frame: f - sec(p.at), fps: 24, config: { damping: 9 } });
        return (
          <div
            key={p.label}
            style={{
              position: "absolute",
              left: p.x - 16,
              top: p.y - 16,
              transform: `scale(${s})`,
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: C.gold,
                boxShadow: `0 0 24px ${C.gold}`,
              }}
            />
            <div
              style={{
                fontFamily: KR,
                fontWeight: 700,
                fontSize: 20,
                color: "#fff",
                marginTop: 6,
                whiteSpace: "nowrap",
                transform: "translateX(-30%)",
              }}
            >
              {p.label}
            </div>
          </div>
        );
      })}
      {cards.map((c) => {
        const s = spring({ frame: f - sec(c.at), fps: 24, config: { damping: 13 } });
        return (
          <div
            key={c.label}
            style={{
              position: "absolute",
              left: c.x - 40,
              top: c.y + 60,
              width: 220,
              opacity: s,
              transform: `translateY(${(1 - s) * 40}px) rotate(${-4 + (c.at > 2 ? 7 : 0)}deg)`,
              background: "#fff",
              padding: 10,
              borderRadius: 14,
              boxShadow: "0 16px 40px #0009",
            }}
          >
            <Img src={staticFile(c.img)} style={{ width: "100%", borderRadius: 8 }} />
            <div
              style={{ fontFamily: KR, fontWeight: 700, fontSize: 17, color: C.ink, marginTop: 8 }}
            >
              {c.label}
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

/** Render progress card (top right) over the subway shot. */
export const RenderCard: React.FC<{ start: number }> = ({ start }) => {
  const f = useCurrentFrame();
  const p = useIn(start);
  const prog = interpolate(f, [start + 4, start + sec(1.6)], [0, 100], clamp);
  const done = prog >= 100;
  return (
    <AbsoluteFill style={{ alignItems: "flex-end", padding: 40 }}>
      <div
        style={{
          opacity: p,
          transform: `translateY(${(1 - p) * -20}px)`,
          width: 380,
          background: "#fff",
          borderRadius: 20,
          padding: "18px 22px",
          boxShadow: "0 16px 40px #0008",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontFamily: KR,
            fontWeight: 700,
            fontSize: 22,
            color: C.ink,
          }}
        >
          <span>{done ? "클라이언트에게 전송 완료" : "최종 렌더링 중"}</span>
          <span style={{ color: done ? "#16A34A" : C.coral }}>
            {done ? "✓" : `${Math.round(prog)}%`}
          </span>
        </div>
        <div
          style={{
            height: 10,
            borderRadius: 6,
            background: "#EEE",
            marginTop: 12,
            overflow: "hidden",
          }}
        >
          <div
            style={{ width: `${prog}%`, height: "100%", background: done ? "#16A34A" : C.coral }}
          />
        </div>
        <div style={{ fontFamily: EN, fontSize: 15, color: "#666", marginTop: 8 }}>
          moonlight_tteokbokki_30s_ko.mp4 · 1080p
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** 43.6–48s: the finished ad she delivered, with the Korean narration. */
export const MiniAd: React.FC = () => {
  const f = useCurrentFrame();
  const zoom = interpolate(f, [0, sec(4.4)], [1.08, 1.0]);
  const l1 = useIn(sec(0.7));
  const l2 = useIn(sec(1.6));
  const lock = useIn(sec(2.7));
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <AbsoluteFill style={{ top: 60, bottom: 60, overflow: "hidden" }}>
        <Img
          src={staticFile("assets/product.jpg")}
          style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${zoom})` }}
        />
        <AbsoluteFill style={{ background: "linear-gradient(90deg, #000c 0%, transparent 55%)" }} />
        <div style={{ position: "absolute", left: 70, top: 150, opacity: 1 - lock }}>
          <div
            style={{
              fontFamily: KR,
              fontWeight: 900,
              fontSize: 64,
              color: "#fff",
              opacity: l1,
              transform: `translateY(${(1 - l1) * 20}px)`,
            }}
          >
            달빛 아래,
          </div>
          <div
            style={{
              fontFamily: KR,
              fontWeight: 900,
              fontSize: 64,
              color: C.gold,
              opacity: l2,
              transform: `translateY(${(1 - l2) * 20}px)`,
            }}
          >
            가장 뜨거운 한 입.
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 70,
            top: 170,
            display: "flex",
            alignItems: "center",
            gap: 18,
            opacity: lock,
            transform: `scale(${0.9 + 0.1 * lock})`,
          }}
        >
          <Mascot size={150} />
          <div
            style={{
              fontFamily: DISPLAY,
              fontWeight: 900,
              fontSize: 104,
              color: C.cream,
              WebkitTextStroke: "2px #5A0A0E",
            }}
          >
            달빛 떡볶이
          </div>
        </div>
      </AbsoluteFill>
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 24,
          fontFamily: KR,
          fontSize: 18,
          color: "#fff9",
        }}
      >
        미리보기 · 달빛 떡볶이 30초 광고
      </div>
    </AbsoluteFill>
  );
};

/** End card over the Namsan skyline. */
export const EndCard: React.FC = () => {
  const f = useCurrentFrame();
  const a = useIn(sec(0.8));
  const b = useIn(sec(1.5));
  const black = interpolate(f, [sec(5.3), sec(6)], [0, 1], clamp);
  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={{ background: "linear-gradient(0deg, #000d 0%, transparent 55%)", opacity: a }}
      />
      <AbsoluteFill
        style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 70, gap: 12 }}
      >
        <div
          style={{
            fontFamily: EN,
            fontWeight: 700,
            fontSize: 40,
            color: "#fff",
            letterSpacing: 6,
            opacity: a,
            transform: `translateY(${(1 - a) * 20}px)`,
          }}
        >
          TRY ACME STUDIO WITH CLAUDE
        </div>
        <div
          style={{
            fontFamily: EN,
            fontWeight: 500,
            fontSize: 24,
            color: C.gold,
            letterSpacing: 8,
            opacity: b,
          }}
        >
          VOICE + MOTION, IN ONE PROMPT
        </div>
        <div style={{ fontFamily: KR, fontWeight: 500, fontSize: 22, color: "#fffc", opacity: b }}>
          목소리부터 영상까지 · acme.example
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "#000", opacity: black }} />
    </AbsoluteFill>
  );
};
