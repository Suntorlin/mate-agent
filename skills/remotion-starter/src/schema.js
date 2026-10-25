// Timeline contract shared by scripts/prepare.mjs (validation before render) and the
// Remotion composition. Plain ESM so Node can import it without a TypeScript toolchain.
// All times are in seconds on the output timeline unless a field says otherwise.
import { z } from "zod";

const seconds = z.number().nonnegative();
const positiveSeconds = z.number().positive();
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp"];
const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "webm", "mkv"];

// A local path (relative to the timeline.json directory, or absolute) or an http(s) URL.
const source = z.string().trim().min(1, "src must not be empty");

const framing = z.strictObject({
  scale: z.number().min(0.1).max(10).default(1),
  // Offset of the frame center, in percent of the canvas size (e.g. -5 = 5% left/up).
  x: z.number().min(-100).max(100).default(0),
  y: z.number().min(-100).max(100).default(0),
});

const transition = z.strictObject({
  type: z.enum(["cut", "crossfade"]).default("cut"),
  duration: positiveSeconds.max(3).default(0.3),
});

const shot = z.strictObject({
  src: source,
  // Inferred from the file extension when omitted; required for URLs without one.
  type: z.enum(["image", "video"]).optional(),
  // Defaults to the end of the previous shot.
  start: seconds.optional(),
  duration: positiveSeconds,
  fit: z.enum(["cover", "contain"]).default("cover"),
  kenBurns: z.strictObject({ from: framing, to: framing }).optional(),
  // Seconds skipped at the beginning of a video source.
  trimStart: seconds.default(0),
  // Volume of a video's own soundtrack; muted by default because reels use separate audio tracks.
  volume: z.number().min(0).max(2).default(0),
  // How this shot enters from the previous one.
  transition: transition.optional(),
});

const position = z.union([
  z.enum(["top", "upper", "center", "lower", "bottom"]),
  z.strictObject({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  }),
]);

const color = z.string().trim().min(1);

const text = z.strictObject({
  text: z.string().min(1, "text must not be empty"),
  start: seconds,
  duration: positiveSeconds,
  style: z.enum(["hook", "title", "caption", "label", "plain"]).default("title"),
  position: position.default("center"),
  fontSize: z.number().positive().max(400).optional(),
  color: color.optional(),
  strokeColor: color.optional(),
  background: color.optional(),
  align: z.enum(["left", "center", "right"]).default("center"),
  maxWidth: z.number().min(0.2).max(1).default(0.88),
  animation: z.enum(["pop", "fade", "none"]).optional(),
});

const word = z.strictObject({
  text: z.string().min(1, "word text must not be empty"),
  start: seconds,
  end: positiveSeconds,
});

const caption = z
  .strictObject({
    words: z.array(word).min(1, "a caption line needs at least one word"),
    // Line visibility; defaults to the first word start and last word end.
    start: seconds.optional(),
    end: positiveSeconds.optional(),
    style: z.enum(["highlight", "box"]).default("highlight"),
    position: position.default("lower"),
    fontSize: z.number().positive().max(400).optional(),
    color: color.optional(),
    highlightColor: color.optional(),
  })
  .superRefine((line, context) => {
    line.words.forEach((item, index) => {
      if (item.end <= item.start) {
        context.addIssue({
          code: "custom",
          path: ["words", index, "end"],
          message: `word "${item.text}" must end after it starts (${item.start}s)`,
        });
      }
      const previous = line.words[index - 1];
      if (previous && item.start < previous.start) {
        context.addIssue({
          code: "custom",
          path: ["words", index, "start"],
          message: `words must be in time order ("${item.text}" starts before "${previous.text}")`,
        });
      }
    });
  });

const audio = z.strictObject({
  src: source,
  start: seconds.default(0),
  volume: z.number().min(0).max(2).default(1),
  trimStart: seconds.default(0),
  // Defaults to the rest of the source (clipped at the end of the video).
  duration: positiveSeconds.optional(),
});

export const timelineSchema = z.strictObject({
  canvas: z
    .strictObject({
      width: z.number().int().min(16).max(4096).default(1080),
      height: z.number().int().min(16).max(4096).default(1920),
      fps: z.number().int().min(1).max(60).default(30),
      background: color.default("#000000"),
    })
    .default({ width: 1080, height: 1920, fps: 30, background: "#000000" }),
  shots: z.array(shot).min(1, "a timeline needs at least one shot"),
  texts: z.array(text).default([]),
  captions: z.array(caption).default([]),
  audio: z.array(audio).default([]),
});

export function isUrl(value) {
  return /^https?:\/\//i.test(value);
}

function extensionOf(value) {
  const path = value.split(/[?#]/)[0];
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return match ? match[1].toLowerCase() : "";
}

export function mediaTypeOf(item) {
  if (item.type) return item.type;
  const extension = extensionOf(item.src);
  if (IMAGE_EXTENSIONS.includes(extension)) return "image";
  if (VIDEO_EXTENSIONS.includes(extension)) return "video";
  return undefined;
}

/** Shots with resolved start times, in drawing order. */
export function placeShots(shots) {
  let cursor = 0;
  return shots.map((item) => {
    const start = item.start ?? cursor;
    cursor = start + item.duration;
    return { ...item, start, end: cursor };
  });
}

export function totalSeconds(timeline) {
  return Math.max(...placeShots(timeline.shots).map((item) => item.end));
}

function formatPath(path) {
  return path.reduce(
    (text, part) => (typeof part === "number" ? `${text}[${part}]` : `${text}.${part}`),
    "timeline"
  );
}

/**
 * Parse and normalize a timeline. Returns { timeline } or { errors: string[] } where every
 * error names the offending JSON path, e.g. `timeline.shots[2].duration: ...`.
 */
export function parseTimeline(input) {
  const result = timelineSchema.safeParse(input);
  if (!result.success) {
    return {
      errors: result.error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`),
    };
  }
  const timeline = result.data;
  const errors = [];
  timeline.shots.forEach((item, index) => {
    if (!mediaTypeOf(item)) {
      errors.push(
        `timeline.shots[${index}].src: cannot tell image from video for "${item.src}"; set "type"`
      );
    }
  });
  const end = errors.length ? 0 : totalSeconds(timeline);
  timeline.texts.forEach((item, index) => {
    if (end && item.start >= end) {
      errors.push(
        `timeline.texts[${index}].start: ${item.start}s is after the video ends (${end}s)`
      );
    }
  });
  timeline.captions.forEach((line, index) => {
    const first = line.words[0].start;
    if (end && first >= end) {
      errors.push(
        `timeline.captions[${index}].words[0].start: ${first}s is after the video ends (${end}s)`
      );
    }
  });
  return errors.length ? { errors } : { timeline };
}
