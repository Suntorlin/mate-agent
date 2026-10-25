#!/usr/bin/env node
// Validate a timeline.json and stage its local media for one Remotion render.
//
//   node scripts/prepare.mjs <timeline.json> <stage-dir>
//
// Writes <stage-dir>/props.json (local srcs rewritten to staged names) and <stage-dir>/public/
// holding only the referenced files. They are hard links when possible, copies otherwise:
// Remotion's static server refuses symlinks.
// Exit code 2 = invalid timeline; every error line names the offending JSON path.
import { execFileSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isUrl, mediaTypeOf, parseTimeline, placeShots, totalSeconds } from "../src/schema.js";

// Tolerance before a source that is shorter than its slot is reported (one frame at 30 fps).
const DURATION_TOLERANCE_SECONDS = 0.034;

function fail(errors) {
  process.stderr.write(`Invalid timeline:\n${errors.map((line) => `  - ${line}`).join("\n")}\n`);
  process.exit(2);
}

function readTimeline(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    fail([`cannot read ${path}: ${error.message}`]);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail([`${path} is not valid JSON: ${error.message}`]);
  }
}

/** Seconds of media in a local file, or undefined when ffprobe cannot tell. */
function probeSeconds(path) {
  try {
    const output = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const value = Number.parseFloat(output.trim());
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function stageFile(source, destination) {
  try {
    linkSync(source, destination);
  } catch {
    copyFileSync(source, destination, constants.COPYFILE_FICLONE);
  }
}

function createStager(baseDir, publicDir, errors) {
  const staged = new Map();
  const localPaths = new Map();
  return {
    stage(src, field) {
      if (isUrl(src)) return src;
      const absolute = resolve(baseDir, src);
      if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        errors.push(`${field}: file not found: ${absolute}`);
        return src;
      }
      if (!staged.has(absolute)) {
        const safeName = basename(absolute).replace(/[^A-Za-z0-9._-]/g, "_");
        const name = `${String(staged.size).padStart(3, "0")}-${safeName}`;
        stageFile(absolute, join(publicDir, name));
        staged.set(absolute, name);
      }
      const name = staged.get(absolute);
      localPaths.set(name, absolute);
      return name;
    },
    localPath: (name) => localPaths.get(name),
  };
}

function sourceWarnings(timeline, stager) {
  const warnings = [];
  const end = totalSeconds(timeline);
  placeShots(timeline.shots).forEach((shot, index) => {
    const path = stager.localPath(shot.src);
    if (!path || mediaTypeOf(shot) !== "video") return;
    const available = (probeSeconds(path) ?? Infinity) - shot.trimStart;
    if (available + DURATION_TOLERANCE_SECONDS < shot.duration) {
      warnings.push(
        `timeline.shots[${index}]: source has ${available.toFixed(2)}s after trimStart but the shot ` +
          `lasts ${shot.duration}s; the last frame will hold. Shorten the shot or use a longer clip.`
      );
    }
  });
  timeline.audio.forEach((track, index) => {
    const path = stager.localPath(track.src);
    if (!path) return;
    const available = (probeSeconds(path) ?? Infinity) - track.trimStart;
    const wanted = track.duration ?? end - track.start;
    if (available <= 0) {
      warnings.push(
        `timeline.audio[${index}]: trimStart is past the end of the source; it is silent.`
      );
    } else if (available + DURATION_TOLERANCE_SECONDS < wanted) {
      warnings.push(
        `timeline.audio[${index}]: source has ${available.toFixed(2)}s after trimStart; ` +
          `it stops ${(wanted - available).toFixed(2)}s before its slot ends.`
      );
    }
  });
  return warnings;
}

function main() {
  const [timelineArg, stageArg] = process.argv.slice(2);
  if (!timelineArg || !stageArg) {
    process.stderr.write("Usage: node scripts/prepare.mjs <timeline.json> <stage-dir>\n");
    process.exit(64);
  }
  const timelinePath = resolve(timelineArg);
  const parsed = parseTimeline(readTimeline(timelinePath));
  if (parsed.errors) fail(parsed.errors);
  const timeline = parsed.timeline;

  const publicDir = join(resolve(stageArg), "public");
  mkdirSync(publicDir, { recursive: true });
  const errors = [];
  const stager = createStager(dirname(timelinePath), publicDir, errors);
  const props = {
    ...timeline,
    shots: timeline.shots.map((shot, index) => ({
      ...shot,
      src: stager.stage(shot.src, `timeline.shots[${index}].src`),
    })),
    audio: timeline.audio.map((track, index) => ({
      ...track,
      src: stager.stage(track.src, `timeline.audio[${index}].src`),
    })),
  };
  if (errors.length) fail(errors);

  for (const warning of sourceWarnings(props, stager)) {
    process.stderr.write(`warning: ${warning}\n`);
  }
  writeFileSync(join(resolve(stageArg), "props.json"), `${JSON.stringify(props)}\n`);
  const seconds = totalSeconds(props);
  const { fps, width, height } = props.canvas;
  process.stdout.write(
    `timeline ok: ${props.shots.length} shots, ${props.texts.length} texts, ` +
      `${props.captions.length} caption lines, ${props.audio.length} audio tracks; ` +
      `${width}x${height} @ ${fps}fps, ${seconds.toFixed(3)}s (${Math.round(seconds * fps)} frames)\n`
  );
}

main();
