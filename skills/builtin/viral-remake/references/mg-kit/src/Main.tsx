import React from "react";
import { AbsoluteFill, Audio, interpolate, OffthreadVideo, Sequence, staticFile } from "remotion";
import { Bubbles, PromptBar, Vignette, sec } from "./ui";
import {
  EndCard,
  Location,
  LogoBuild,
  MarketMap,
  MascotPop,
  MiniAd,
  RenderCard,
  Title,
  VoiceCasting,
} from "./scenes";

/** One live-action shot: [start, end) on the timeline, trimmed from `from` seconds into the clip. */
type Shot = { clip: string; start: number; end: number; from?: number };

const SHOTS: Shot[] = [
  { clip: "v_s1", start: 0, end: 4 },
  { clip: "v_s2", start: 4, end: 8 },
  { clip: "v_s3", start: 8, end: 11 },
  { clip: "v_s4", start: 11, end: 15 },
  { clip: "v_s6", start: 20, end: 24 },
  { clip: "v_s8", start: 29, end: 33 },
  { clip: "v_s10", start: 37, end: 39.6 },
  { clip: "v_s11", start: 39.6, end: 43.6 },
  { clip: "v_s12", start: 48, end: 51 },
  { clip: "v_s13", start: 51, end: 57, from: 0 },
];

const SFX: [string, number, number?][] = [
  ["whoosh", 14.8],
  ["whoosh", 19.8],
  ["whoosh", 23.8],
  ["whoosh", 28.8],
  ["whoosh", 32.8],
  ["whoosh", 36.8],
  ["whoosh", 43.4],
  ["notify", 8.6],
  ["notify", 9.5],
  ["notify", 48.4],
  ["notify", 49.3],
  ["pop", 17.4],
  ["pop", 20.7],
  ["pop", 33.5],
  ["pop", 34.4],
  ["pop", 35.3],
  ["ding", 43.2],
];

const typingClicks = (start: number, end: number) =>
  Array.from(
    { length: Math.floor((end - start) / 0.085) },
    (_, i) => start + i * 0.085 + (i % 3) * 0.012
  );

const Shot: React.FC<{ s: Shot }> = ({ s }) => (
  <Sequence from={sec(s.start)} durationInFrames={sec(s.end) - sec(s.start)}>
    <AbsoluteFill>
      <OffthreadVideo
        src={staticFile(`clips/${s.clip}.mp4`)}
        startFrom={sec(s.from ?? 0)}
        muted
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
      <Vignette />
    </AbsoluteFill>
  </Sequence>
);

const At: React.FC<{ from: number; to: number; children: React.ReactNode }> = ({
  from,
  to,
  children,
}) => (
  <Sequence from={sec(from)} durationInFrames={sec(to) - sec(from)}>
    {children}
  </Sequence>
);

export const Main: React.FC = () => (
  <AbsoluteFill style={{ background: "#000" }}>
    {SHOTS.map((s) => (
      <Shot key={s.clip} s={s} />
    ))}

    <At from={0} to={4}>
      <Title />
    </At>
    <At from={4} to={8}>
      <Location text="서울 · 오후 11:47" />
    </At>
    <At from={8} to={11}>
      <Bubbles
        sender="김대표 · 달빛떡볶이"
        lines={[
          { at: sec(0.6), text: "내일 아침 9시까지 30초 광고 가능?? 🙏" },
          { at: sec(1.5), text: "한국어 내레이션도요!!" },
        ]}
      />
    </At>
    <At from={11} to={15}>
      <PromptBar
        text="달빛 떡볶이 30초 광고 만들어줘. 한국어 내레이션 포함."
        start={sec(0.4)}
        sentAt={sec(3.2)}
        hideAt={sec(3.6)}
      />
    </At>
    <At from={15} to={20}>
      <LogoBuild />
    </At>
    <At from={20} to={24}>
      <MascotPop />
    </At>
    <At from={24} to={29}>
      <VoiceCasting />
    </At>
    <At from={29} to={33}>
      <PromptBar
        text="시장 지도도 만들어줘. 가게 사진이랑 같이."
        start={sec(0.5)}
        sentAt={sec(2.9)}
        hideAt={sec(3.4)}
      />
    </At>
    <At from={33} to={37}>
      <MarketMap />
    </At>
    <At from={39.6} to={43.6}>
      <PromptBar
        text="최종 렌더링해서 클라이언트한테 보내줘!"
        start={sec(0.2)}
        sentAt={sec(1.9)}
        hideAt={sec(2.1)}
      />
      <RenderCard start={sec(2.0)} />
    </At>
    <At from={43.6} to={48}>
      <MiniAd />
    </At>
    <At from={48} to={51}>
      <Bubbles
        sender="김대표 · 달빛떡볶이"
        lines={[
          { at: sec(0.4), text: "완벽해요!! 👏" },
          { at: sec(1.3), text: "다음 브리프: 한강 치킨 광고 🍗" },
        ]}
      />
    </At>
    <At from={51} to={57}>
      <EndCard />
    </At>

    <Audio
      src={staticFile("audio/music.wav")}
      volume={(f) =>
        0.85 *
        interpolate(f, [sec(44.0), sec(44.3), sec(47.4), sec(47.9)], [1, 0.4, 0.4, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      }
    />
    <Sequence from={sec(44.3)}>
      <Audio src={staticFile("audio/vo_main.mp3")} volume={1.0} />
    </Sequence>
    {SFX.map(([name, t, v], i) => (
      <Sequence key={`${name}${i}`} from={sec(t)}>
        <Audio src={staticFile(`audio/sfx_${name}.wav`)} volume={v ?? 0.8} />
      </Sequence>
    ))}
    {[...typingClicks(11.4, 13.9), ...typingClicks(29.5, 31.6), ...typingClicks(39.8, 41.3)].map(
      (t, i) => (
        <Sequence key={`k${i}`} from={sec(t)} durationInFrames={3}>
          <Audio src={staticFile("audio/sfx_key.wav")} volume={0.35} />
        </Sequence>
      )
    )}
  </AbsoluteFill>
);
